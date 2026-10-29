export type Variant = {
  name: string;
  selection: string;
  floor: number;
  ceiling: number;
};

/** Each selection has its own band; folder variants may share a name. */
export function bandFor(variants: Variant[], selected: Variant) {
  const bands = new Map(variants.map((variant) => [variant.name, {
    floor: variant.floor,
    ceiling: variant.ceiling,
  }]));
  return bands.get(selected.name);
}
