/**
 * Deterministic fun name generator for anonymous wallet addresses.
 * Same address always produces the same name.
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
];

export function generateTraderName(address: string): string {
  // Use first 8 hex chars as seed
  const hex = address.replace(/^0x/i, "").slice(0, 8);
  const seed = parseInt(hex, 16);
  const adj = adjectives[seed % adjectives.length];
  const animal = animals[Math.floor(seed / adjectives.length) % animals.length];
  const num = (seed % 99) + 1;
  return `${adj}${animal}${num}`;
}

/** Get display name or generate one */
export function getTraderDisplayName(address: string, displayName: string | null): string {
  return displayName || generateTraderName(address);
}
