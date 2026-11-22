'use strict';

/* Genre classification.
   A place's genres come from (in order): your manual choice, its OpenStreetMap cuisine tags,
   keywords in its name, a list of well-known UAE chains, and finally its type (café / fast food). */

const GENRES = [
  { id: 'korean', label: 'Korean', emoji: '🍲' },
  { id: 'japanese', label: 'Japanese', emoji: '🍣' },
  { id: 'chinese', label: 'Chinese', emoji: '🥡' },
  { id: 'seasian', label: 'Thai & SE Asian', emoji: '🍜' },
  { id: 'asian', label: 'Asian', emoji: '🥢' },
  { id: 'indian', label: 'Indian & Pakistani', emoji: '🍛' },
  { id: 'arabic', label: 'Arabic & Middle Eastern', emoji: '🧆' },
  { id: 'italian', label: 'Italian', emoji: '🍝' },
  { id: 'pizza', label: 'Pizza', emoji: '🍕' },
  { id: 'burgers', label: 'Burgers', emoji: '🍔' },
  { id: 'chicken', label: 'Chicken', emoji: '🍗' },
  { id: 'fastfood', label: 'Fast food & snacks', emoji: '🌯' },
  { id: 'american', label: 'American', emoji: '🗽' },
  { id: 'grill', label: 'Steak & grill', emoji: '🥩' },
  { id: 'seafood', label: 'Seafood', emoji: '🦐' },
  { id: 'mexican', label: 'Mexican & Latin', emoji: '🌮' },
  { id: 'european', label: 'French & European', emoji: '🥖' },
  { id: 'healthy', label: 'Healthy & salads', emoji: '🥗' },
  { id: 'breakfast', label: 'Breakfast & brunch', emoji: '🍳' },
  { id: 'cafe', label: 'Café & coffee', emoji: '☕' },
  { id: 'dessert', label: 'Desserts & bakery', emoji: '🍰' },
  { id: 'international', label: 'International', emoji: '🌍' },
];
const GENRE_BY_ID = Object.fromEntries(GENRES.map((g) => [g.id, g]));

// Keyword rules, applied to cuisine tags and to the place name. Order matters: first matches win.
const GENRE_RULES = [
  ['korean', /\b(korean|korea|kimchi|bibimbap|seoul|k-?bbq|tteok)/],
  ['japanese', /\b(japanese|japan|sushi|ramen|izakaya|teppanyaki|udon|yakitori|tokyo|sashimi|robata|bento)/],
  ['chinese', /\b(chinese|china|dim ?sum|szechuan|sichuan|cantonese|mongolian|taiwanese|peking|dumpling|noodle house|wok)\b/],
  ['seasian', /\b(thai|thailand|vietnam\w*|pho|indonesian?|malaysian?|filipin\w*|philippin\w*|pinoy|singapore\w*|laksa|bali|nasi)\b/],
  ['indian', /\b(indian|india|pakistani?|hyderabadi|biryani|biriyani|tandoor\w*|masala|curry|kerala|malabar|sri lankan|nepal\w*|bangladeshi|dhaba|chaat|dosa|punjabi|mughal|desi|karahi|tikka)\b/],
  ['arabic', /\b(lebanese|leban\w*|arab\w*|syrian|iraqi|egyptian|emirati|khaleeji|yemeni|mandi|turkish|turk\w*|persian|iranian|uzbek|kebab|kabab|kebap|shawarma|shawerma|falafe?l|falafil|manaqish|manakish|man'?oushe|mezze|mezza|hummus|foul|fawal|beirut|damascus|istanbul|bosph?or\w*|regional|local|kunafa|gulf|bawadi|phoenician|majlis|tarbouche|hubbly bubbly)\b/],
  ['pizza', /\b(pizza\w*|pizzeria)\b/],
  ['italian', /\b(italian|italia|pasta|trattoria|osteria|risotto|il forno|gelato|ristorante|cucina|napoli\w*|roma)\b/],
  ['burgers', /\b(burgers?|smash)\b/],
  ['chicken', /\b(chicken|wings?|fried chicken|broast\w*|peri[- ]?peri|nando'?s|poulet|dajaj|farrouj)\b/],
  ['seafood', /\b(sea ?food|fish|shrimp|prawns?|lobster|crab|oyster|samak|sea ?shell|fish and chips|poke)\b/],
  ['grill', /\b(steak\w*|grill\w*|barbecue|bbq|smokehouse|charcoal|meat)\b/],
  ['mexican', /\b(mexican|mexico|tex-mex|taco\w*|burrito\w*|brazilian|peruvian|caribbean|latin\w*|argentin\w*|cantina)\b/],
  ['american', /\b(american|diner|dinner|wings|hot ?dogs?|new york|texas|southern)\b/],
  ['european', /\b(french|bistro|brasserie|spanish|tapas|greek|portuguese|belgian|russian|german|british|english|continental|mediterranean|pub|creperie|akropolis|acropolis)\b/],
  ['healthy', /\b(salads?|healthy|organic|vegan|vegetarian|plant[- ]based|acai|bowls?|keto|juice|smoothie|fresh)\b/],
  ['breakfast', /\b(breakfast|brunch|pancakes?|eggs?|waffles?)\b/],
  ['dessert', /\b(ice ?cream|gelato|donuts?|doughnuts?|cakes?|desserts?|sweets?|bakery|bakeries|pastry|patisserie|chocolate|crepes?|cookies?|kalacs|cinnamon|cupcakes?|frozen yogh?urt)\b/],
  ['cafe', /\b(coffee|cafe|café|espresso|roaster\w*|tea|karak|chai|bubble tea|boba)\b/],
  ['fastfood', /\b(fast ?food|sandwich\w*|subs?|bagels?|deli|sausage|snacks?|cafeteria|refreshments?|takeaway|shawarma)\b/],
  ['asian', /\b(asian|asia|pan-asian|oriental|asiatic)\b/],
  ['international', /\b(international|fusion|world|global|continental)\b/],
];

// Well-known chains whose names don't contain a genre keyword.
const BRAND_GENRES = [
  [/mcdonald|burger king|hardee|five guys|shake shack|johnny rockets|black tap|pickl|\bsalt\b|fatburger|wendy|carl'?s jr|smashi/, ['burgers']],
  [/\bkfc\b|popeyes|texas chicken|wingstop|jollibee|nando|raising cane|al baik|albaik|chicken tikka/, ['chicken']],
  [/subway|arby|charleys|tim hortons/, ['fastfood']],
  [/pizza hut|domino|papa john|little caesar|sbarro|motorino|crust/, ['pizza']],
  [/il forno|eataly|olive garden|carluccio|zafferano|antonia|l'?arte|cipriani|scalini/, ['italian']],
  [/starbucks|costa|caribou|tim hortons|%arabica|arabica|nespresso|blacksmith|esquires|second cup|common grounds|seattle'?s best|dose|brew/, ['cafe']],
  [/dunkin|krispy|baskin|cold stone|cinnabon|magnolia|kurtos|lady ?m|lenotre|patchi|bateel|kunafa|knafeh|wake n bake|crumbs|eclair/, ['dessert']],
  [/peppermill|biryani pot|copper chimney|gazebo|bombay|delhi|calicut|kozhikode/, ['indian']],
  [/mugg & bean|mugg and bean|caffe nero|joe & the juice|the coffee club/, ['cafe']],
  [/zaatar w zeit|operation falafel|allo beirut|al mallah|abd el wahab|beirut sur mer|em sherif|reem al bawadi|automatic|bait el khetyar|tannour|lebanese|shish|al safadi/, ['arabic']],
  [/wagamama|pf chang|p\.f\. chang|asiatic|noodle|panda express|yo! sushi|sushi counter|niri|nobu|zuma|hakkasan|yuan|ting irie/, ['asian']],
  [/paul\b|le pain quotidien|la serre|raclette|angelina|ladurée|laduree/, ['european', 'cafe']],
  [/kcal|calo|right bite|eat clean|soil|alkalime|freshii|salad|poke/, ['healthy']],
  [/tashas|jones the grocer|eggspectation|the breakfast club|ihop|denny/, ['breakfast', 'cafe']],
  [/burro blanco|little mexico|chipotle|taco bell|el chido|maya/, ['mexican']],
  [/hawksbill|marketplace|beach house|steak room/, ['international']],
];

function inferGenres(place) {
  // place: { name, cuisines[], type, genres? }
  if (Array.isArray(place.genres) && place.genres.length) return place.genres.filter((g) => GENRE_BY_ID[g]);
  const found = [];
  const add = (g) => { if (!found.includes(g)) found.push(g); };
  const cuisineText = (place.cuisines || []).join(' ; ').toLowerCase().replace(/_/g, ' ');
  const nameText = String(place.name || '').toLowerCase();

  for (const [g, re] of GENRE_RULES) if (cuisineText && re.test(cuisineText)) add(g);
  if (found.length < 2) for (const [g, re] of GENRE_RULES) if (re.test(nameText)) add(g);
  if (!found.length) for (const [re, gs] of BRAND_GENRES) if (re.test(nameText)) gs.forEach(add);
  if (!found.length) {
    if (place.type === 'cafe') add('cafe');
    else if (place.type === 'fast_food') add('fastfood');
  }
  // "cafe" in a restaurant's name rarely means coffee is the main thing; keep it secondary.
  if (found.length > 1 && found[0] === 'cafe') found.push(found.shift());
  return found.slice(0, 2);
}

/* How well a genre fits a meal (1 = neutral). Used to weight suggestions. */
const MEAL_FIT = {
  breakfast: { breakfast: 3, cafe: 2.2, dessert: 1.4, arabic: 1.4, healthy: 1.3, fastfood: 0.8, european: 1.1,
    burgers: 0.25, pizza: 0.25, grill: 0.2, seafood: 0.2, korean: 0.3, japanese: 0.3, chinese: 0.3, indian: 0.6, mexican: 0.4 },
  lunch: { cafe: 0.6, dessert: 0.35, breakfast: 0.7 },
  dinner: { cafe: 0.3, dessert: 0.35, breakfast: 0.2, grill: 1.3, seafood: 1.2, healthy: 0.8 },
  'late night': { fastfood: 1.7, burgers: 1.7, pizza: 1.6, chicken: 1.6, arabic: 1.4, dessert: 0.9,
    cafe: 0.4, breakfast: 0.2, healthy: 0.5, european: 0.6, seafood: 0.6 },
};
function mealFit(genres, meal) {
  const table = MEAL_FIT[meal] || {};
  if (!genres.length) return 0.8;
  return Math.max(...genres.map((g) => table[g] ?? 1));
}

/* Genres that are usually cheap when you haven't set a price yourself. */
const BUDGET_GENRES = new Set(['fastfood', 'chicken', 'burgers', 'pizza', 'indian', 'arabic', 'cafe']);
