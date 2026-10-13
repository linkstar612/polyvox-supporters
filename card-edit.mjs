// R-OJJ.11: a supporter personalizes their own card from inside Polyvox.
//
// Shared by the doorman Worker (worker/card-route.js, which accepts an edit)
// and the aggregator (cards.mjs, which merges it), so the two can never
// disagree about what an edit may contain. No side effects and no Node-only
// imports: the Worker bundles this file as it is.
//
// What an edit can set is deliberately small: a display name, a short tagline,
// an accent and a background picked from the lists below, and optionally a
// VRChat profile picture URL on VRChat's own image hosts. There is no image
// upload and no free color, so nothing on the wall is something this repo
// would have to host or moderate as an image.

/// Accent colors a card may wear. Ids are permanent: card-edits.json and
/// installed apps key on them, so a color is retuned here and never renamed.
export const CARD_ACCENTS = [
  { id: "rose", color: "#fb7185" },
  { id: "amber", color: "#fbbf24" },
  { id: "lime", color: "#a3e635" },
  { id: "emerald", color: "#34d399" },
  { id: "sky", color: "#38bdf8" },
  { id: "indigo", color: "#818cf8" },
  { id: "violet", color: "#a78bfa" },
  { id: "pink", color: "#f472b6" },
  { id: "slate", color: "#94a3b8" },
];

/// Card backgrounds, each a two-stop gradient drawn top-left to bottom-right.
/// Same permanence rule as the accents.
export const CARD_BACKGROUNDS = [
  { id: "midnight", from: "#0f172a", to: "#1e1b4b" },
  { id: "dusk", from: "#312e81", to: "#9d174d" },
  { id: "forest", from: "#052e16", to: "#166534" },
  { id: "ocean", from: "#082f49", to: "#0e7490" },
  { id: "ember", from: "#431407", to: "#9a3412" },
  { id: "plum", from: "#2e1065", to: "#6b21a8" },
  { id: "graphite", from: "#18181b", to: "#3f3f46" },
];

/// Field limits, in Unicode code points after trimming.
export const CARD_LIMITS = { name: 32, tagline: 60, avatar_url: 512 };

/// The hosts a VRChat profile picture is served from. `api.vrchat.cloud`
/// carries `/api/1/file/...` and `/api/1/image/...`; the others are VRChat's
/// file and asset CDNs. Exact host match over https only: a lookalike such as
/// `api.vrchat.cloud.example` is refused.
export const VRCHAT_IMAGE_HOSTS = [
  "api.vrchat.cloud",
  "files.vrchat.cloud",
  "assets.vrchat.com",
  "d348imysud55la.cloudfront.net",
];

/// How long a code waits between two accepted edits.
export const CARD_EDIT_INTERVAL_S = 600;

const ACCENT_IDS = new Set(CARD_ACCENTS.map((a) => a.id));
const BACKGROUND_IDS = new Set(CARD_BACKGROUNDS.map((b) => b.id));

// C0 and C1 controls, plus the bidi overrides and isolates, which can make a
// name render as something it is not.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

const length = (s) => [...s].length;

/// The published preset catalog, so the app draws a new preset without a
/// release.
export const CARD_PRESETS = {
  accents: CARD_ACCENTS,
  backgrounds: CARD_BACKGROUNDS,
  limits: CARD_LIMITS,
};

/** Whether `url` is an https URL on one of VRChat's own image hosts. */
export function isVrchatImage(url) {
  if (typeof url !== "string" || length(url) > CARD_LIMITS.avatar_url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    VRCHAT_IMAGE_HOSTS.includes(u.hostname.toLowerCase())
  );
}

/** Check an edit as a request carried it.
 *
 *  Returns `{ edit }`, the normalized fields (an empty or absent field is left
 *  out, meaning "use the card's default"), or `{ error, field }` naming the
 *  first field that is wrong. A field of the wrong type is an error, not a
 *  silent drop: the editor shows what it sent, and a value it never stored
 *  would read as a bug. */
export function checkEdit(body = {}) {
  const edit = {};
  const text = (field, max) => {
    const raw = body?.[field];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return { error: "invalid_field", field };
    const v = raw.normalize("NFC").trim();
    if (UNSAFE_TEXT.test(v) || length(v) > max) return { error: "invalid_field", field };
    if (v) edit[field] = v;
    return null;
  };
  const pick = (field, ids) => {
    const raw = body?.[field];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || !ids.has(raw)) return { error: "invalid_field", field };
    edit[field] = raw;
    return null;
  };
  const avatar = () => {
    const raw = body?.avatar_url;
    if (raw === undefined || raw === null || raw === "") return null;
    if (!isVrchatImage(raw)) return { error: "invalid_field", field: "avatar_url" };
    edit.avatar_url = raw;
    return null;
  };
  const err =
    text("name", CARD_LIMITS.name) ??
    text("tagline", CARD_LIMITS.tagline) ??
    pick("accent", ACCENT_IDS) ??
    pick("background", BACKGROUND_IDS) ??
    avatar();
  return err ?? { edit };
}
