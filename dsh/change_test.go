//go:build unix

package dsh

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
	"github.com/Luthiel/AutoFixer/sandbox"
)

// DAT-258: a real local preparation run edits an isolated checkout, validates
// it, and stops. The control plane must freeze exactly that revision —
// workspace + repository + base/head SHA, diff, summary, test results,
// digests, and evidence — and every other outcome (no validation, a later
// edit, cancellation, an unauthorized stop) must keep its truthful state and
// produce no candidate.

// gitFixture is one real repository revision a run may materialize. The
// template only ever serves reads: capture works on a copy, so the template's
// refs are the proof that freezing writes nothing remotely or locally.
type gitFixture struct {
	template string
	baseSHA  string
}

func newGitFixture(t *testing.T, files map[string]string) gitFixture {
	t.Helper()
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "--quiet", "--initial-branch", "main")
	for rel, content := range files {
		abs := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git("add", "--all")
	git("commit", "--quiet", "-m", "base")
	return gitFixture{template: dir, baseSHA: git("rev-parse", "HEAD")}
}

// fixtureFiles is the checkout shape structuredCreate scopes.
func fixtureFiles() map[string]string {
	return map[string]string{
		"web/src/export.ts": "export const button = 1;\n",
		"go.mod":            "module example.com/fixture\n",
	}
}

// gitFixtureSource materializes the fixture's pinned revision into the
// sandbox workspace as a real git checkout holding the requested base.
type gitFixtureSource struct{ fixture gitFixture }

func (s gitFixtureSource) Materialize(_ context.Context, repoDir, repositoryURL, baseSHA string) (sandbox.RevisionIdentity, error) {
	if repositoryURL != delivery.AllowedRepositoryURL || baseSHA != s.fixture.baseSHA {
		return sandbox.RevisionIdentity{}, fmt.Errorf("dsh test: fixture does not hold %s at %s", repositoryURL, baseSHA)
	}
	if err := copyFixtureTree(s.fixture.template, repoDir); err != nil {
		return sandbox.RevisionIdentity{}, err
	}
	digest, err := fixtureTreeDigest(repoDir)
	if err != nil {
		return sandbox.RevisionIdentity{}, err
	}
	return sandbox.RevisionIdentity{RepositoryURL: repositoryURL, BaseSHA: baseSHA, TreeDigest: digest}, nil
}

func copyFixtureTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode().Perm())
	})
}

// fixtureTreeDigest mirrors the sandbox's working-tree digest contract:
// every regular file except the checkout's own .git internals.
func fixtureTreeDigest(root string) (string, error) {
	h := sha256.New()
	var files []string
	err := filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if p != root && entry.Name() == ".git" {
				return fs.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return "", err
	}
	for _, rel := range files {
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(content)
		fmt.Fprintf(h, "%s\x00%s\n", rel, hex.EncodeToString(sum[:]))
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

// fixtureProfile is a registered test profile that succeeds deterministically.
// The real go.test/node.test commands would need a toolchain and network;
// validation evidence only requires a registered profile whose completion
// event carries an exit status.
func fixtureProfiles() []sandbox.ExecProfile {
	return []sandbox.ExecProfile{{
		ID:                  "go.test",
		Kind:                sandbox.ProfileTest,
		Command:             "/bin/echo",
		Modes:               []string{"focused", "suite"},
		MaxWallClockSeconds: 30,
		OutputLimitBytes:    1 << 20,
		Build: func(mode, target string) ([]string, error) {
			return []string{"validated", target}, nil
		},
	}}
}

// passthroughFixtureIsolator owns the whole execution domain without
// wrapping the process, so the lifecycle tests run on hosts whose real backend
// refuses untrusted execution (DAT-253). Test-only.
type passthroughFixtureIsolator struct{}

func (passthroughFixtureIsolator) Name() string     { return "test-passthrough" }
func (passthroughFixtureIsolator) Available() error { return nil }
func (passthroughFixtureIsolator) ExecutionDomain() sandbox.ExecutionDomain {
	return sandbox.DomainComplete
}

func (passthroughFixtureIsolator) Wrap(*exec.Cmd, sandbox.IsolationRequest) (sandbox.EnvironmentIdentity, error) {
	return sandbox.EnvironmentIdentity{
		Platform: "test",
		Backend:  "test-passthrough",
		Network:  "deny_all",
	}, nil
}

func fixtureEnv(t *testing.T, fixture gitFixture) *testEnv {
	t.Helper()
	return startEnv(t,
		func(c *Config) { c.RevisionSource = gitFixtureSource{fixture: fixture} },
		func(c *Config) { c.Profiles = fixtureProfiles() },
		func(c *Config) { c.Isolator = passthroughFixtureIsolator{} },
	)
}

func createPreparation(t *testing.T, env *testEnv, fixture gitFixture, taskID string) string {
	t.Helper()
	req := structuredCreate(taskID, "repo.read", "workspace.patch", "test.run")
	req.Repository.BaseSHA = fixture.baseSHA
	status, raw := env.do("POST", "/v1/runs", req)
	wantStatus(t, status, raw, http.StatusCreated)
	return decodeInto[createRunResponse](t, raw).RunID
}

func submitFixtureAction(t *testing.T, env *testEnv, runID, actionID, toolID string, args map[string]any, pathScope string) actionResponse {
	t.Helper()
	status, raw := env.do("POST", "/v1/runs/"+runID+"/actions",
		structuredAction(actionID, toolID, args, pathScope))
	wantStatus(t, status, raw, http.StatusAccepted)
	return decodeInto[actionResponse](t, raw)
}

// materializeWorkspace reads one file: the structured read is the dispatch
// that materializes the isolated checkout, exactly as Pi's first read does.
func materializeWorkspace(t *testing.T, env *testEnv, runID string) {
	t.Helper()
	resp := submitFixtureAction(t, env, runID, "act_read_"+runID, "repo.read",
		map[string]any{"path": "web/src/export.ts"}, "web/src/export.ts")
	if resp.Result == nil || resp.Result.Revision == nil {
		t.Fatalf("read did not bind a revision: %+v", resp.Result)
	}
}

func editWorkspace(t *testing.T, env *testEnv, runID, actionID, content string) {
	t.Helper()
	resp := submitFixtureAction(t, env, runID, actionID, "workspace.patch",
		map[string]any{"path": "web/src/export.ts", "content": content}, "web/src/export.ts")
	if resp.Result == nil {
		t.Fatalf("edit did not return a structured result: %+v", resp)
	}
}

func validateWorkspace(t *testing.T, env *testEnv, runID, actionID string) {
	t.Helper()
	resp := submitFixtureAction(t, env, runID, actionID, "test.run",
		map[string]any{"profile": "go.test", "mode": "focused", "target": "web/src/export.ts"}, "web/src/export.ts")
	if resp.Result == nil || resp.Result.ExitStatus == nil || *resp.Result.ExitStatus != 0 {
		t.Fatalf("test run did not complete successfully: %+v", resp.Result)
	}
}

func stopPreparation(t *testing.T, env *testEnv, runID string) stopResponse {
	t.Helper()
	status, raw := env.do("POST", "/v1/runs/"+runID+"/stop", stopRequest{
		RequestedBy: approvalActor{ActorID: "usr_01J", Identity: "github:aphrodite"},
		Reason:      "Local preparation completed.",
	})
	wantStatus(t, status, raw, http.StatusOK)
	return decodeInto[stopResponse](t, raw)
}

// rawArtifact keeps the envelope's digest and the exact content bytes so a
// test can recompute the diff digest independently.
type rawArtifact struct {
	RunID        string          `json:"run_id"`
	ArtifactType string          `json:"artifact_type"`
	Digest       harness.Digest  `json:"digest"`
	Content      json.RawMessage `json:"content"`
}

func readArtifact[T any](t *testing.T, env *testEnv, runID, artifactID string) (rawArtifact, T) {
	t.Helper()
	status, raw := env.do("GET", "/v1/runs/"+runID+"/artifacts/"+artifactID, nil)
	wantStatus(t, status, raw, http.StatusOK)
	envelope := decodeInto[rawArtifact](t, raw)
	if envelope.ArtifactType != artifactID {
		t.Fatalf("artifact type = %q, want %q", envelope.ArtifactType, artifactID)
	}
	var content T
	if err := json.Unmarshal(envelope.Content, &content); err != nil {
		t.Fatalf("decode %s content: %v", artifactID, err)
	}
	return envelope, content
}

func wantArtifactMissing(t *testing.T, env *testEnv, runID, artifactID string) {
	t.Helper()
	status, raw := env.do("GET", "/v1/runs/"+runID+"/artifacts/"+artifactID, nil)
	wantError(t, status, raw, http.StatusNotFound, CodeArtifactNotFound)
}

func TestStopFreezesValidatedPreparation(t *testing.T) {
	fixture := newGitFixture(t, fixtureFiles())
	env := fixtureEnv(t, fixture)
	runID := createPreparation(t, env, fixture, "tsk_prepared")

	materializeWorkspace(t, env, runID)
	editWorkspace(t, env, runID, "act_edit_1", "export const button = 2;\n")
	validateWorkspace(t, env, runID, "act_test_1")

	stopped := stopPreparation(t, env, runID)
	if stopped.State != harness.StateStopped || !stopped.Stopped || !stopped.Prepared {
		t.Fatalf("stop response = %+v, want a stopped, prepared run", stopped)
	}
	if stopped.AuditEventReference == "" {
		t.Error("stop response has no audit event reference")
	}

	// Completion is idempotent: a repeated stop observes the same prepared
	// revision instead of creating another one.
	_, firstReport := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
	again := stopPreparation(t, env, runID)
	if again.State != harness.StateStopped || !again.Prepared {
		t.Fatalf("repeated stop = %+v, want the same stopped, prepared run", again)
	}
	_, repeatedReport := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
	if firstReport.HeadSHA == nil || repeatedReport.HeadSHA == nil || *firstReport.HeadSHA != *repeatedReport.HeadSHA {
		t.Fatalf("repeated stop changed the frozen head: %v vs %v", firstReport.HeadSHA, repeatedReport.HeadSHA)
	}

	status, raw := env.do("GET", "/v1/runs/"+runID, nil)
	wantStatus(t, status, raw, http.StatusOK)
	run := decodeInto[runResponse](t, raw)
	if run.State != harness.StateStopped {
		t.Fatalf("run state = %q, want stopped", run.State)
	}
	if run.PatchReport == nil || run.PatchReport.PatchStatus != delivery.PatchPreparedNoPR {
		t.Fatalf("run patch report = %+v, want prepared_no_pr", run.PatchReport)
	}

	_, report := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
	if report.PatchStatus != delivery.PatchPreparedNoPR {
		t.Fatalf("patch status = %q, want %q", report.PatchStatus, delivery.PatchPreparedNoPR)
	}
	if report.BaseSHA != fixture.baseSHA {
		t.Errorf("patch base = %q, want %q", report.BaseSHA, fixture.baseSHA)
	}
	if report.Branch == nil || !strings.HasPrefix(*report.Branch, delivery.BranchPrefix) {
		t.Fatalf("patch branch = %v, want an autofixer/* name", report.Branch)
	}
	if report.HeadSHA == nil || !isHexObjectID(*report.HeadSHA) {
		t.Fatalf("patch head = %v, want a full commit id", report.HeadSHA)
	}
	if len(report.Validation) != 1 {
		t.Fatalf("validation attempts = %d, want 1", len(report.Validation))
	}
	attempt := report.Validation[0]
	if attempt.Tool != "go.test" || attempt.ExitStatus == nil || *attempt.ExitStatus != 0 {
		t.Fatalf("validation attempt = %+v, want a passing go.test attempt", attempt)
	}
	if attempt.EventReference == "" || attempt.OutputDigest.Value == "" {
		t.Errorf("validation attempt lacks its evidence reference or output digest: %+v", attempt)
	}
	if len(report.EvidenceReferences) == 0 {
		t.Error("patch report has no evidence references")
	}

	envelope, diff := readArtifact[changeArtifact](t, env, runID, "patch_diff")
	if diff.BaseSHA != fixture.baseSHA || diff.HeadSHA != *report.HeadSHA {
		t.Fatalf("diff identity = %s..%s, want %s..%s", diff.BaseSHA, diff.HeadSHA, fixture.baseSHA, *report.HeadSHA)
	}
	if !strings.Contains(diff.Diff, "export const button = 2;") {
		t.Errorf("diff does not contain the prepared content:\n%s", diff.Diff)
	}
	sum := sha256.Sum256([]byte(diff.Diff))
	if got := hex.EncodeToString(sum[:]); got != diff.DiffDigest {
		t.Errorf("diff digest = %q, want sha256(diff) = %q", diff.DiffDigest, got)
	}
	if envelope.Digest.Value == "" {
		t.Error("patch_diff artifact has no envelope digest")
	}
	if len(diff.ChangedPaths) != 1 || diff.ChangedPaths[0] != "web/src/export.ts" {
		t.Errorf("changed paths = %v, want [web/src/export.ts]", diff.ChangedPaths)
	}
	if diff.Insertions != 1 || diff.Deletions != 1 {
		t.Errorf("stats = +%d -%d, want +1 -1", diff.Insertions, diff.Deletions)
	}

	_, validation := readArtifact[validationArtifact](t, env, runID, "validation_summary")
	if validation.HeadSHA == nil || *validation.HeadSHA != diff.HeadSHA {
		t.Errorf("validation summary head = %v, want %s", validation.HeadSHA, diff.HeadSHA)
	}
	if len(validation.Validation) != 1 || *validation.Validation[0].ExitStatus != 0 {
		t.Errorf("validation summary attempts = %+v, want the passing attempt", validation.Validation)
	}

	_, candidate := readArtifact[candidateArtifact](t, env, runID, "candidate")
	if candidate.BaseSHA != fixture.baseSHA || candidate.HeadSHA != diff.HeadSHA || candidate.TreeSHA != diff.TreeSHA {
		t.Errorf("candidate identity = %+v, want the frozen base/tree/head", candidate)
	}
	if candidate.DiffDigest != diff.DiffDigest {
		t.Errorf("candidate diff digest = %q, want %q", candidate.DiffDigest, diff.DiffDigest)
	}
	if candidate.RepositoryURL != delivery.AllowedRepositoryURL {
		t.Errorf("candidate repository = %q, want %q", candidate.RepositoryURL, delivery.AllowedRepositoryURL)
	}
	if candidate.Branch != *report.Branch || candidate.TaskID != "tsk_prepared" {
		t.Errorf("candidate branch/task = %q/%q, want %q/tsk_prepared", candidate.Branch, candidate.TaskID, *report.Branch)
	}
	if len(candidate.Validation) != 1 || len(candidate.EvidenceReferences) < 2 {
		t.Errorf("candidate lacks validation evidence: %+v", candidate)
	}

	status, raw = env.do("GET", "/v1/runs/"+runID+"/evidence-bundle", nil)
	wantStatus(t, status, raw, http.StatusOK)
	bundle := decodeInto[bundleResponse](t, raw)
	if err := bundle.Bundle.Validate(); err != nil {
		t.Fatalf("evidence bundle does not validate: %v", err)
	}
	if bundle.Bundle.PatchReport.PatchStatus != delivery.PatchPreparedNoPR || bundle.Bundle.PatchReport.HeadSHA == nil ||
		*bundle.Bundle.PatchReport.HeadSHA != diff.HeadSHA {
		t.Errorf("bundle patch report = %+v, want the frozen head", bundle.Bundle.PatchReport)
	}
	if bundle.Bundle.ApprovalSnapshot.HeadSHA == nil || *bundle.Bundle.ApprovalSnapshot.HeadSHA != diff.HeadSHA {
		t.Errorf("approval snapshot head = %v, want %s", bundle.Bundle.ApprovalSnapshot.HeadSHA, diff.HeadSHA)
	}
	revisionBound := false
	for _, event := range bundle.Bundle.ExecutionEvents {
		if event.DecisionOrStopCode != nil && *event.DecisionOrStopCode == harness.DecisionRevisionPrepared {
			revisionBound = true
		}
	}
	if !revisionBound {
		t.Error("evidence chain has no revision_prepared binding event")
	}

	// Freezing is local-only: the source repository still holds exactly its
	// base branch, no autofixer branch, and no remote.
	assertTemplateUntouched(t, fixture)
}

func TestPreparationWithoutValidationIsNotACandidate(t *testing.T) {
	fixture := newGitFixture(t, fixtureFiles())
	env := fixtureEnv(t, fixture)
	runID := createPreparation(t, env, fixture, "tsk_unvalidated")

	materializeWorkspace(t, env, runID)
	editWorkspace(t, env, runID, "act_edit_1", "export const button = 2;\n")

	stopped := stopPreparation(t, env, runID)
	if stopped.State != harness.StateStopped || stopped.Prepared {
		t.Fatalf("stop response = %+v, want stopped without a prepared revision", stopped)
	}
	_, report := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
	if report.PatchStatus != delivery.PatchNotCreated || report.HeadSHA != nil || report.Branch != nil {
		t.Fatalf("patch report = %+v, want not_created with null head and branch", report)
	}
	if !strings.Contains(report.ChangeSummary, "no test evidence") {
		t.Errorf("summary = %q, want it to explain the missing validation", report.ChangeSummary)
	}
	wantArtifactMissing(t, env, runID, "patch_diff")
	wantArtifactMissing(t, env, runID, "validation_summary")
	wantArtifactMissing(t, env, runID, "candidate")
}

func TestEditAfterValidationDoesNotProduceACandidate(t *testing.T) {
	fixture := newGitFixture(t, fixtureFiles())
	env := fixtureEnv(t, fixture)
	runID := createPreparation(t, env, fixture, "tsk_drift")

	materializeWorkspace(t, env, runID)
	editWorkspace(t, env, runID, "act_edit_1", "export const button = 2;\n")
	validateWorkspace(t, env, runID, "act_test_1")
	// The tested tree is no longer the prepared tree: the earlier passing
	// result belongs to an earlier revision and cannot validate this one.
	editWorkspace(t, env, runID, "act_edit_2", "export const button = 3;\n")

	stopped := stopPreparation(t, env, runID)
	if stopped.State != harness.StateStopped || stopped.Prepared {
		t.Fatalf("stop response = %+v, want stopped without a prepared revision", stopped)
	}
	_, report := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
	if report.PatchStatus != delivery.PatchNotCreated {
		t.Fatalf("patch status = %q, want not_created", report.PatchStatus)
	}
	wantArtifactMissing(t, env, runID, "patch_diff")
	wantArtifactMissing(t, env, runID, "candidate")
}

func TestCancelledPreparationKeepsNoCandidate(t *testing.T) {
	fixture := newGitFixture(t, fixtureFiles())
	env := fixtureEnv(t, fixture)
	runID := createPreparation(t, env, fixture, "tsk_cancelled")

	materializeWorkspace(t, env, runID)
	editWorkspace(t, env, runID, "act_edit_1", "export const button = 2;\n")
	validateWorkspace(t, env, runID, "act_test_1")

	status, raw := env.do("POST", "/v1/runs/"+runID+"/cancel", cancelRequest{
		RequestedBy: approvalActor{ActorID: "usr_01J", Identity: "github:aphrodite"},
		Reason:      "The operator stopped the task.",
	})
	wantStatus(t, status, raw, http.StatusAccepted)
	cancelled := decodeInto[cancelResponse](t, raw)
	if cancelled.State != harness.StateCancelled {
		t.Fatalf("cancel state = %q, want cancelled", cancelled.State)
	}
	_, report := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
	if report.PatchStatus != delivery.PatchNotCreated {
		t.Fatalf("patch status after cancel = %q, want not_created", report.PatchStatus)
	}
	wantArtifactMissing(t, env, runID, "patch_diff")
	wantArtifactMissing(t, env, runID, "candidate")
	assertTemplateUntouched(t, fixture)
}

func TestPreparedCandidateIdentityIsContentAddressed(t *testing.T) {
	fixture := newGitFixture(t, fixtureFiles())
	env := fixtureEnv(t, fixture)

	type prepared struct {
		report    delivery.PatchReport
		diff      changeArtifact
		candidate candidateArtifact
	}
	prepare := func(taskID, content string) prepared {
		t.Helper()
		runID := createPreparation(t, env, fixture, taskID)
		materializeWorkspace(t, env, runID)
		editWorkspace(t, env, runID, "act_edit_"+taskID, content)
		validateWorkspace(t, env, runID, "act_test_"+taskID)
		stopPreparation(t, env, runID)
		_, report := readArtifact[delivery.PatchReport](t, env, runID, "patch_report")
		_, diff := readArtifact[changeArtifact](t, env, runID, "patch_diff")
		_, candidate := readArtifact[candidateArtifact](t, env, runID, "candidate")
		if report.PatchStatus != delivery.PatchPreparedNoPR || report.HeadSHA == nil || *report.HeadSHA != diff.HeadSHA {
			t.Fatalf("report and diff disagree on the frozen head: %+v vs %s", report, diff.HeadSHA)
		}
		return prepared{report: report, diff: diff, candidate: candidate}
	}

	first := prepare("tsk_ident_a", "export const button = 2;\n")
	second := prepare("tsk_ident_b", "export const button = 3;\n")

	if *first.report.HeadSHA == *second.report.HeadSHA {
		t.Error("different content froze the same head; content is not part of the identity")
	}
	if first.diff.DiffDigest == second.diff.DiffDigest {
		t.Error("different content produced the same diff digest")
	}
	if first.diff.BaseSHA != fixture.baseSHA || second.diff.BaseSHA != fixture.baseSHA {
		t.Errorf("base SHA drifted across runs: %s / %s", first.diff.BaseSHA, second.diff.BaseSHA)
	}
	for _, got := range []prepared{first, second} {
		if got.candidate.HeadSHA != got.diff.HeadSHA || got.candidate.TreeSHA != got.diff.TreeSHA ||
			got.candidate.DiffDigest != got.diff.DiffDigest {
			t.Errorf("candidate identity does not match its diff: %+v vs %+v", got.candidate, got.diff)
		}
	}
	assertTemplateUntouched(t, fixture)
}

func TestStopRequiresAuthorization(t *testing.T) {
	fixture := newGitFixture(t, fixtureFiles())
	env := fixtureEnv(t, fixture)
	runID := createPreparation(t, env, fixture, "tsk_stop_auth")
	materializeWorkspace(t, env, runID)

	status, raw := env.do("POST", "/v1/runs/"+runID+"/stop", stopRequest{
		RequestedBy: approvalActor{ActorID: "usr_evil", Identity: "github:stranger"},
		Reason:      "I want it to stop.",
	})
	wantError(t, status, raw, http.StatusForbidden, CodeApproverNotAuthorized)

	status, raw = env.do("GET", "/v1/runs/"+runID, nil)
	wantStatus(t, status, raw, http.StatusOK)
	run := decodeInto[runResponse](t, raw)
	if run.State != harness.StateRunning {
		t.Errorf("state after refused stop = %q, want running", run.State)
	}
	stopPreparation(t, env, runID)
}

// assertTemplateUntouched proves capture created no branch or remote write:
// the fixture still holds exactly the base branch and no autofixer ref.
func assertTemplateUntouched(t *testing.T, fixture gitFixture) {
	t.Helper()
	refs, err := exec.Command("git", "-C", fixture.template, "for-each-ref", "--format=%(refname)").Output()
	if err != nil {
		t.Fatalf("list fixture refs: %v", err)
	}
	lines := strings.Fields(strings.TrimSpace(string(refs)))
	if len(lines) != 1 || lines[0] != "refs/heads/main" {
		t.Fatalf("fixture refs = %v, want only refs/heads/main", lines)
	}
	if out, err := exec.Command("git", "-C", fixture.template, "remote").Output(); err != nil || strings.TrimSpace(string(out)) != "" {
		t.Fatalf("fixture remotes = %q (err %v), want none", out, err)
	}
	if out, err := exec.Command("git", "-C", fixture.template, "rev-parse", "HEAD").Output(); err != nil ||
		strings.TrimSpace(string(out)) != fixture.baseSHA {
		t.Fatalf("fixture HEAD = %q (err %v), want %s", out, err, fixture.baseSHA)
	}
}

func isHexObjectID(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, r := range value {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return false
		}
	}
	return true
}
