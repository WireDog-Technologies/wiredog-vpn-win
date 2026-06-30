// Hardcoded city positions as percentages of SVG viewBox (2000x1200)
// x: 0 = left edge, 100 = right edge
// y: 0 = top edge, 100 = bottom edge
export const cityPositions: Record<string, { x: number; y: number }> = {
  'New York City': { x: 90, y: 34 },
  'Los Angeles': { x: 15, y: 57 },
  'San Francisco': { x: 11, y: 42 },
  'Dallas': { x: 52, y: 71 },
  'Houston': { x: 56, y: 81 },
  'Miami': { x: 85, y: 91 },
  'Chicago': { x: 67, y: 37 },
  'Seattle': { x: 17, y: 8 },
  'Atlanta': { x: 75.5, y: 65 },
  'Denver': { x: 40, y: 45 },
  'Phoenix': { x: 26.5, y: 64 },
  'Las Vegas': { x: 22, y: 53 },
  'Boston': { x: 93, y: 28 },
  'Philadelphia': { x: 88, y: 38 },
  'Columbus': { x: 76, y: 42 },
  'Detroit': { x: 74, y: 34 },
  'Charlotte': { x: 81, y: 58 },
  'Portland': { x: 15, y: 16 },
  'Richmond': { x: 85.5, y: 49 },
  'Newark': { x: 89, y: 36 },
  'Minneapolis': { x: 56, y: 24 },
  'Chantilly': { x: 85, y: 43.75 },
  'Honolulu': { x: 33.5, y: 88.17 },
  'Nashville': { x: 69.5, y: 57.5 },
  'Salt Lake City': { x: 28.75, y: 37.92 },
  'San Jose': { x: 10.5, y: 42.5 },
  'Silicon Valley': { x: 10.5, y: 42.5 },
  'Home Lab': { x: 85, y: 44 }
};

export const getPositionForCity = (city: string): { x: number; y: number } => {
  const position = cityPositions[city];
  if (!position) {
    console.warn(`No position mapped for city: ${city}`);
    return { x: 50, y: 5 }; // Default: top center
  }
  return position;
};
