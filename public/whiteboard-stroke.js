const maxInputPoints = 1024;
const maxCurveSegments = 16;
const hitTolerance = .25;
const maxCornerRadius = 12;

function midpointBlend(point, neighbor, amount) {
  return [point[0] + (neighbor[0] - point[0]) * amount, point[1] + (neighbor[1] - point[1]) * amount];
}

function sampleQuadratic(points, start, control, end) {
  const deviation = Math.hypot(start[0] - 2 * control[0] + end[0], start[1] - 2 * control[1] + end[1]) / 4;
  const segments = Math.min(maxCurveSegments, Math.max(1, Math.ceil(Math.sqrt(deviation / hitTolerance))));
  for (let step = 1; step < segments; step++) {
    const t = step / segments;
    const a = (1 - t) ** 2;
    const b = 2 * (1 - t) * t;
    const c = t * t;
    points.push([a * start[0] + b * control[0] + c * end[0], a * start[1] + b * control[1] + c * end[1]]);
  }
  points.push(end);
}

export function strokeCurve(raw) {
  if (!Array.isArray(raw) || !raw.length) return {path:'',points:[]};
  const source = raw.length <= maxInputPoints ? raw : Array.from({length:maxInputPoints}, (_, index) =>
    raw[Math.floor(index * (raw.length - 1) / (maxInputPoints - 1))]);
  const input = source.filter(point => Array.isArray(point) && point.length === 2 &&
    Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .filter((point, index, points) => index === 0 ||
      point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
  if (!input.length) return {path:'',points:[]};

  let last = [...input[0]];
  const points = [last];
  let path = `M${last.join(' ')}`;
  for (let index = 1; index < input.length - 1; index++) {
    const previous = input[index - 1];
    const current = input[index];
    const next = input[index + 1];
    const before = Math.hypot(previous[0] - current[0], previous[1] - current[1]);
    const after = Math.hypot(next[0] - current[0], next[1] - current[1]);
    const radius = Math.min(before / 2, after / 2, maxCornerRadius);
    // Round each bend locally so sparse input still follows the original turn.
    const enter = midpointBlend(current, previous, radius / before);
    const exit = midpointBlend(current, next, radius / after);
    if (enter[0] !== last[0] || enter[1] !== last[1]) {
      path += `L${enter.join(' ')}`;
      points.push(enter);
    }
    path += `Q${current.join(' ')} ${exit.join(' ')}`;
    sampleQuadratic(points, enter, current, exit);
    last = exit;
  }

  const end = [...input.at(-1)];
  path += `L${end.join(' ')}`;
  if (end[0] !== last[0] || end[1] !== last[1]) points.push(end);
  return {path, points};
}
