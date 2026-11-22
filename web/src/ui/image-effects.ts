export type EffectFilter = "ascii" | "dither";

export type EffectPalette = "original" | "meadow" | "blue" | "amber" | "lavender" | "mono";

export type InkTone = "shadows" | "highlights";

/** The active settings object is shared by the layer renderer and its panel. */
export interface EffectSettings {
  filter: EffectFilter;
  mask: number;
  palette: EffectPalette;
  inkTone: InkTone;
  strength: number;
  size: number;
  spacing: number;
}

/** The selected treatment used on the finished sign-in artwork. */
export const LOGIN_EFFECT_SETTINGS: EffectSettings = {
  filter: "ascii",
  mask: 29,
  palette: "amber",
  inkTone: "shadows",
  strength: 22,
  size: 15,
  spacing: 8,
};

export const RECOMMENDED_EFFECT_SETTINGS: Record<EffectFilter, EffectSettings> = {
  ascii: {
    filter: "ascii",
    mask: 90,
    palette: "original",
    inkTone: "shadows",
    strength: 100,
    size: 37,
    spacing: 0,
  },
  dither: {
    filter: "dither",
    mask: 88,
    palette: "original",
    inkTone: "shadows",
    strength: 100,
    size: 15,
    spacing: 0,
  },
};

export const EFFECT_PALETTES: Record<
  Exclude<EffectPalette, "original">,
  [string, string, string, string]
> = {
  meadow: ["#2B361F", "#677D45", "#AEBA78", "#E5E1BD"],
  blue: ["#192A4D", "#326AC5", "#A2C2F1", "#EDF3FC"],
  amber: ["#3C200F", "#A74C15", "#EF9A46", "#F7E7CA"],
  lavender: ["#292144", "#6552AB", "#B3A5E4", "#F0ECFB"],
  mono: ["#151515", "#575757", "#A6A6A6", "#ECECEC"],
};
