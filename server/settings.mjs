// Settings that belong to the whole workspace and are saved in workspace.json. Each section is validated here,
// so the browser can only ever store values the server understands.

export const REVIEW_DEFAULTS = Object.freeze({ enabled: true, maxLines: 300, maxFiles: 10, hardStop: true, margin: 25 });
const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

export function cleanReview(input, current = REVIEW_DEFAULTS) {
  const r = input && typeof input === 'object' ? input : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : current.enabled,
    maxLines: int(r.maxLines, 20, 5000, current.maxLines),
    maxFiles: int(r.maxFiles, 1, 200, current.maxFiles),
    hardStop: typeof r.hardStop === 'boolean' ? r.hardStop : current.hardStop,
    margin: int(r.margin, 5, 100, current.margin),
  };
}

export function createSettings({ saved }) {
  let review = cleanReview(saved.settings?.review);
  return {
    review: () => review,
    state: () => ({ review }),
    save(input) {
      if (!input || typeof input !== 'object') throw new Error('Invalid settings.');
      if (input.review !== undefined) review = cleanReview(input.review, review);
      return { review };
    },
  };
}
