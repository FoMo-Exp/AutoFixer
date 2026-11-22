import type { CSSProperties, ReactElement } from "react";
import { EFFECT_PALETTES } from "./image-effects";
import type { EffectFilter, EffectPalette, EffectSettings, InkTone } from "./image-effects";

interface EffectPanelProps {
  settings: EffectSettings;
  videoSrc: string;
  onChange: (settings: EffectSettings) => void;
  onFilterChange: (filter: EffectFilter) => void;
  onReset: () => void;
}

const PALETTES: { id: EffectPalette; label: string }[] = [
  { id: "original", label: "Original" },
  { id: "meadow", label: "Meadow" },
  { id: "blue", label: "Blue" },
  { id: "amber", label: "Amber" },
  { id: "lavender", label: "Lavender" },
  { id: "mono", label: "Mono" },
];

function SliderRow({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}): ReactElement {
  const style = { "--effect-value": `${value}%` } as CSSProperties;
  return (
    <div className="effect-control-row">
      <span className="effect-control-label">{label}</span>
      <div className="effect-slider-control">
        <div className="effect-slider-track" style={style}>
          <input
            aria-label={label}
            className="effect-slider"
            max={100}
            min={0}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            type="range"
            value={value}
          />
        </div>
        <output className="effect-number" aria-label={`${label} value`}>
          {value}
          {suffix}
        </output>
      </div>
    </div>
  );
}

export function EffectPanel({
  settings,
  videoSrc,
  onChange,
  onFilterChange,
  onReset,
}: EffectPanelProps): ReactElement {
  const update = (patch: Partial<EffectSettings>): void => onChange({ ...settings, ...patch });

  return (
    <section className="effect-panel" aria-label="Image effect controls">
      <div className="effect-panel-heading">
        <h2>Effect</h2>
        <button className="effect-reset" onClick={onReset} type="button">
          Reset to recommended
        </button>
      </div>

      <SliderRow label="Mask effect" onChange={(mask) => update({ mask })} value={settings.mask} />

      <div className="effect-control-row">
        <span className="effect-control-label">Filter</span>
        <div className="effect-segmented" role="tablist" aria-label="Effect filter">
          {(["ascii", "dither"] as const).map((filter) => (
            <button
              aria-selected={settings.filter === filter}
              className={settings.filter === filter ? "effect-segment is-active" : "effect-segment"}
              key={filter}
              onClick={() => onFilterChange(filter)}
              role="tab"
              type="button"
            >
              {filter === "ascii" ? "ASCII" : "Dither"}
            </button>
          ))}
        </div>
      </div>

      <div className="effect-control-row">
        <span className="effect-control-label">Color</span>
        <div className="effect-swatches" role="group" aria-label="Color palette">
          {PALETTES.map(({ id, label }) => (
            <button
              aria-label={label}
              aria-pressed={settings.palette === id}
              className={settings.palette === id ? "effect-swatch is-selected" : "effect-swatch"}
              key={id}
              onClick={() => update({ palette: id })}
              title={label}
              type="button"
            >
              {id === "original" ? (
                <video
                  aria-hidden="true"
                  autoPlay
                  className="effect-swatch-video"
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  src={videoSrc}
                  tabIndex={-1}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="effect-swatch-palette"
                  style={{
                    backgroundImage: `linear-gradient(135deg, ${EFFECT_PALETTES[id][1]}, ${EFFECT_PALETTES[id][2]})`,
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {settings.filter === "ascii" && (
        <div className="effect-control-row">
          <span className="effect-control-label">Sample tones</span>
          <div
            className="effect-segmented effect-tone-control"
            role="group"
            aria-label="Sample tones"
          >
            {(["shadows", "highlights"] as const).map((tone: InkTone) => (
              <button
                aria-pressed={settings.inkTone === tone}
                className={
                  settings.inkTone === tone ? "effect-segment is-active" : "effect-segment"
                }
                key={tone}
                onClick={() => update({ inkTone: tone })}
                type="button"
              >
                {tone === "shadows" ? "Shadows" : "Highlights"}
              </button>
            ))}
          </div>
        </div>
      )}

      <SliderRow
        label="Sampling strength"
        onChange={(strength) => update({ strength })}
        value={settings.strength}
      />
      <SliderRow label="Size" onChange={(size) => update({ size })} value={settings.size} />
      <SliderRow
        label="Spacing"
        onChange={(spacing) => update({ spacing })}
        suffix="%"
        value={settings.spacing}
      />
    </section>
  );
}
