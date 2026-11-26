export function polygonNormal(vertices, indices) {
  const vector = [0, 0, 0];
  for (const [index, vertex] of indices.entries()) {
    const [x, y, z] = vertices[vertex];
    const [nextX, nextY, nextZ] = vertices[indices[(index + 1) % indices.length]];
    vector[0] += (y - nextY) * (z + nextZ);
    vector[1] += (z - nextZ) * (x + nextX);
    vector[2] += (x - nextX) * (y + nextY);
  }
  return vector;
}

export function inspectMesh(vertices, faces, minimum, maximum) {
  const seen = new Map();
  const duplicates = [];
  let duplicateCount = 0;
  for (const [index, point] of vertices.entries()) {
    const key = point.join(',');
    if (seen.has(key)) {
      duplicateCount++;
      if (duplicates.length < 24) duplicates.push({index,original:seen.get(key)});
    } else seen.set(key,index);
  }
  const degenerate = faces.filter(face => Math.hypot(...face.normal) <= 1e-12);
  return {
    minimum,maximum,dimensions:maximum.map((value,index) => value - minimum[index]),
    duplicateCount,duplicates,degenerateCount:degenerate.length,degenerate:degenerate.slice(0,24),
  };
}

export function projectedPolygonContains(points, indices, x, y) {
  let inside = false;
  let [lastX,lastY] = points[indices.at(-1)];
  for (const index of indices) {
    const [nextX,nextY] = points[index];
    if ((lastY > y) !== (nextY > y) && x < (nextX - lastX) * (y - lastY) / (nextY - lastY) + lastX) inside = !inside;
    lastX = nextX;
    lastY = nextY;
  }
  return inside;
}

const axes = ['X','Y','Z'];
const colors = ['#f78087','#80d69d','#78b7fa'];

export function drawMeshGuides(context, project, guide, width, height, scale) {
  const {origin, minimum, maximum, radius, unit} = guide;
  const line = (a,b) => {
    context.moveTo(a[0],a[1]);
    context.lineTo(b[0],b[1]);
  };
  context.save();
  context.strokeStyle = '#c8deea';
  context.lineWidth = 1;
  context.setLineDash([4,3]);
  context.beginPath();
  for (let edge = 0; edge < 8; edge++) {
    const point = minimum.map((low,axis) => edge & (1 << axis) ? maximum[axis] : low);
    for (let axis = 0; axis < 3; axis++) {
      if (edge & (1 << axis)) continue;
      const endpoint = [...point];
      endpoint[axis] = maximum[axis];
      line(project(point),project(endpoint));
    }
  }
  context.stroke();
  context.setLineDash([]);
  context.font = '11px sans-serif';
  const displayOrigin = project(origin);
  const originVisible = displayOrigin[0] >= 0 && displayOrigin[0] <= width && displayOrigin[1] >= 0 && displayOrigin[1] <= height;
  const start = originVisible ? displayOrigin : [30,height - 36];
  const reference = originVisible ? origin : [0,0,0];
  const referencePoint = project(reference);
  for (let axis = 0; axis < 3; axis++) {
    const endpoint = reference.map((value,index) => value + (index === axis ? 29 / scale : 0));
    const point = project(endpoint);
    const projected = [start[0] + point[0] - referencePoint[0],start[1] + point[1] - referencePoint[1]];
    context.fillStyle = context.strokeStyle = colors[axis];
    context.beginPath();
    line(start,projected);
    context.stroke();
    context.fillText(axes[axis],projected[0] + 3,projected[1] - 2);
  }
  context.fillStyle = '#e5eef4';
  context.fillText(originVisible ? 'O' : '原点在画面外',start[0] + 4,start[1] + 12);
  const maxTick = Math.min(98,width * .22) / scale * radius;
  if (Number.isFinite(maxTick) && maxTick > 0 && width > 125) {
    const power = 10 ** Math.floor(Math.log10(maxTick));
    const tick = (maxTick >= power * 5 ? 5 : maxTick >= power * 2 ? 2 : 1) * power;
    const left = width - tick / radius * scale - 15;
    const right = width - 15;
    const top = height - 15;
    context.strokeStyle = '#e5eef4';
    context.beginPath();
    line([left,top],[right,top]);
    line([left,top - 4],[left,top + 4]);
    line([right,top - 4],[right,top + 4]);
    context.stroke();
    context.textAlign = 'right';
    context.fillText(`${Number(tick.toPrecision(2))} ${unit || '源单位'}`,right,top - 7);
  }
  context.restore();
}
