// Hardcoded city positions as percentages of SVG viewBox (2000x1200)
// x: 0 = left edge, 100 = right edge
// y: 0 = top edge, 100 = bottom edge
export const cityPositions: Record<string, { x: number; y: number }> = {
  'Atlanta': { x: 75.5, y: 65 },
  'Boston': { x: 93.5, y: 27.75 },
  'Chantilly': { x: 85, y: 43.75 },
  'Charlotte': { x: 81.5, y: 58.33 },
  'Chicago': { x: 67.75, y: 36.67 },
  'Columbus': { x: 75.75, y: 41.67 },
  'Dallas': { x: 52.5, y: 70.83 },
  'Denver': { x: 38.75, y: 44.58 },
  'Detroit': { x: 74, y: 34 },
  'Honolulu': { x: 33.5, y: 88.17 },
  'Houston': { x: 56, y: 81 },
  'Las Vegas': { x: 22, y: 52.92 },
  'Los Angeles': { x: 15.75, y: 60 },
  'Miami': { x: 85.35, y: 91.25 },
  'Minneapolis': { x: 56, y: 24 },
  'Nashville': { x: 69.5, y: 57.5 },
  'Newark': { x: 88.8, y: 35 },
  'New York': { x: 90, y: 34.58 },
  'Philadelphia': { x: 88.8, y: 37.5 },
  'Phoenix': { x: 26.25, y: 62.92 },
  'Portland': { x: 15, y: 15.42 },
  'Richmond': { x: 85.75, y: 48.33 },
  'Salt Lake City': { x: 28.75, y: 37.92 },
  'San Francisco': { x: 10.5, y: 42.5 },
  'San Jose': { x: 10.5, y: 42.5 },
  'Seattle': { x: 16.5, y: 8 },
  'Silicon Valley': { x: 10.5, y: 42.5 }
};

export const getPositionForCity = (city: string): { x: number; y: number } => {
  const position = cityPositions[city];
  if (!position) {
    console.warn(`No position mapped for city: ${city}`);
    return { x: 50, y: 5 }; // Default: top center
  }
  return position;
};
