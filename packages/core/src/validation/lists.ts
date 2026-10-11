/**
 * Small, curated watch-lists for risk screening. A hit means "a human should look", never
 * "this is infringing". They are not a substitute for a trademark or copyright search.
 */
export const TRADEMARK_WATCHLIST = [
  'disney', 'pixar', 'marvel', 'star wars', 'harry potter', 'hogwarts', 'pokemon', 'pokémon', 'nintendo', 'super mario', 'zelda',
  'minecraft', 'roblox', 'fortnite', 'lego', 'barbie', 'hello kitty', 'peppa pig', 'paw patrol', 'bluey', 'sesame street',
  'spider-man', 'spiderman', 'batman', 'superman', 'dc comics', 'nfl', 'nba', 'mlb', 'nhl', 'fifa', 'olympic',
  'nike', 'adidas', 'coca-cola', 'coca cola', 'starbucks', 'mcdonald', 'iphone', 'google', 'youtube', 'tiktok',
  'instagram', 'facebook', 'netflix', 'taylor swift', 'beatles', 'elvis', 'harley-davidson', 'jeep', 'ferrari', 'nasa',
  'weight watchers', 'crossfit', 'zumba', 'peloton', 'cricut', 'monopoly', 'scrabble', 'rubik',
  'sharpie', 'post-it', 'velcro', 'kleenex', 'yellowstone', 'bridgerton', 'stranger things',
];

export const COPYRIGHT_SIGNALS: { re: RegExp; label: string }[] = [
  { re: /\blyrics?\b/i, label: 'song lyrics reference' },
  { re: /\b(chapter|excerpt|passage) (from|of) [A-Z][\w' ]+/, label: 'excerpt of another work' },
  { re: /(“|")[^"”]{120,}(”|")/, label: 'long quotation' },
  { re: /\b(reprinted|used) with permission\b/i, label: 'permission notice (verify permission on file)' },
  { re: /\b(fan fiction|fanfic|unofficial guide)\b/i, label: 'derivative work' },
];

export const RESTRICTED_SIGNALS: { re: RegExp; label: string }[] = [
  { re: /\b(porn|pornographic|explicit sex|erotica)\b/i, label: 'sexually explicit content' },
  { re: /\b(how to (make|build) (a )?(bomb|explosive|weapon))\b/i, label: 'dangerous instructions' },
  { re: /\b(nazi|white power|ethnic cleansing)\b/i, label: 'hate content' },
  { re: /\b(self[- ]harm|suicide method)/i, label: 'self-harm content' },
  { re: /\b(public domain)\b/i, label: 'public-domain material (KDP has differentiation requirements)' },
];

export const PLACEHOLDER_RE = /(\{\{|\}\}|lorem ipsum|\bTODO\b|\bTBD\b|\[insert|placeholder|xxx+)/i;
