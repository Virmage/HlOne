/**
 * Deterministic fun name generator for anonymous wallet addresses.
 * Same address always produces the same name.
 *
 * Uses two separate parts of the address hash to pick adjective and animal
 * independently, reducing the chance of similar names appearing together.
 * Number uses a third slice for additional uniqueness.
 */

const adjectives = [
  "Swift", "Silent", "Bold", "Lucky", "Neon", "Iron", "Dark", "Frost",
  "Ghost", "Rapid", "Solar", "Lunar", "Cyber", "Alpha", "Omega", "Turbo",
  "Stealth", "Atomic", "Sonic", "Hyper", "Nova", "Blaze", "Storm", "Flash",
  "Venom", "Apex", "Titan", "Rogue", "Zen", "Dusk", "Prime", "Nitro",
  "Echo", "Pulse", "Drift", "Onyx", "Jade", "Coral", "Ember", "Volt",
  "Astral", "Cobalt", "Crimson", "Mystic", "Obsidian", "Phantom", "Quantum",
  "Savage", "Shadow", "Velvet", "Wicked", "Arctic", "Binary", "Chrome",
  "Diamond", "Elite", "Feral", "Golden", "Hollow", "Ivory", "Jet",
  "Scarlet", "Manic", "Crypt", "Primal", "Void", "Flux", "Haze", "Nuke",
  "Pixel", "Rust", "Slate", "Thorn", "Ultra", "Viral", "Zero", "Ruin",
  "Glitch", "Smog", "Spark", "Forge", "Grim", "Havoc", "Jinx", "Karma",
];

const animals = [
  "Whale", "Shark", "Eagle", "Wolf", "Tiger", "Falcon", "Viper", "Bear",
  "Hawk", "Lion", "Panther", "Cobra", "Fox", "Raven", "Mantis", "Dragon",
  "Phoenix", "Jaguar", "Condor", "Orca", "Lynx", "Raptor", "Kraken",
  "Scorpion", "Stallion", "Hornet", "Gecko", "Mako", "Puma", "Asp",
  "Barracuda", "Cheetah", "Dingo", "Ferret", "Gryphon", "Hydra",
  "Ibis", "Jackal", "Kestrel", "Leopard", "Mongoose", "Narwhal",
  "Osprey", "Python", "Quetzal", "Rhino", "Sable", "Taipan",
  "Urchin", "Vulture", "Wren", "Xerus", "Yak", "Zebu",
  "Basilisk", "Coyote", "Ermine", "Gator", "Hyena", "Iguana",
  "Komodo", "Lemur", "Moth", "Newt", "Ocelot", "Piranha",
  "Rook", "Sphinx", "Toad", "Urial", "Vole", "Wasp",
];

// 88 adjectives × 68 animals × 999 numbers = ~6M unique names
export function generateTraderName(address: string): string {
  const hex = address.replace(/^0x/i, "");

  // Use different slices of the address for each component
  const adjSeed = parseInt(hex.slice(0, 6), 16);  // chars 0-5
  const animalSeed = parseInt(hex.slice(6, 12), 16); // chars 6-11
  const numSeed = parseInt(hex.slice(12, 18), 16);   // chars 12-17

  const adj = adjectives[adjSeed % adjectives.length];
  const animal = animals[animalSeed % animals.length];
  const num = (numSeed % 999) + 1; // 1-999 for more spread

  return `${adj}${animal}${num}`;
}

/** Get display name — @ prefix for real HL names, generated for anonymous */
export function getTraderDisplayName(address: string, displayName: string | null): string {
  if (displayName) return `@${displayName}`;
  return generateTraderName(address);
}
