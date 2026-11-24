type Point = Readonly<{ x: number; y: number }>;

/** Stepped series jump at the release time; continuous cliffs split instead of sloping into the cliff. */
export function scheduleLines(
  points: readonly Point[],
  stepped: boolean,
): readonly (readonly Point[])[] {
  if (stepped)
    return [[...new Map(points.map((point) => [point.x, point])).values()]];
  const segments: Point[][] = [[]];
  for (const point of points) {
    const previous = segments.at(-1)!.at(-1);
    if (previous && previous.x === point.x && previous.y !== point.y)
      segments.push([]);
    if (!previous || previous.x !== point.x || previous.y !== point.y)
      segments.at(-1)!.push(point);
  }
  return segments;
}
