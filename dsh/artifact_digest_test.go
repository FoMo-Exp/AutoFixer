package dsh

import (
	"testing"

	"github.com/Luthiel/AutoFixer/delivery"
	"github.com/Luthiel/AutoFixer/harness"
)

// TestArtifactEnvelopeDigestGolden pins the exact bytes dsh hashes for an
// artifact envelope. Node recomputes the same digest from the served content
// before it trusts any artifact, so a change to Go's JSON encoding (escaping,
// field order, UTF-8 handling) would make every real preparation unreadable.
// The Node bridge asserts the identical golden digest.
func TestArtifactEnvelopeDigestGolden(t *testing.T) {
	status := 0
	head := "héad sep"
	branch := "autofixer/golden"
	content := validationArtifact{
		RunID:   "run_golden",
		State:   harness.StateStopped,
		BaseSHA: "a<b>&c",
		HeadSHA: &head,
		Branch:  &branch,
		Validation: []delivery.ValidationEvidence{{
			Tool:       "go.test",
			Arguments:  []string{"go.test", "focused"},
			ExitStatus: &status,
			OutputDigest: harness.Digest{
				Algorithm: harness.DigestAlgorithmSHA256,
				Value:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			},
			EventReference: "evidence://events/run_golden/3",
		}},
	}
	raw, err := marshalCanonical(content)
	if err != nil {
		t.Fatalf("marshal artifact content: %v", err)
	}
	const want = "b0484dbebfcb6483009b910fed253107ea254f3ceebe0c966174f8680b89407f"
	if got := sha256Hex(raw); got != want {
		t.Fatalf("artifact envelope digest = %q, want %q; encoding drift breaks Node content verification", got, want)
	}
}
