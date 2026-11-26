export const explorerPathFormats = [
  ['windows','Windows 参数（双引号）'],
  ['powershell','PowerShell 字符串或数组'],
  ['json','JSON 字符串或数组'],
];

function windowsArgument(value) {
  const escaped = value.replace(/(\\*)"/g,(_,slashes) => slashes + slashes + '\\"')
    .replace(/\\+$/u,slashes => slashes + slashes);
  return '"' + escaped + '"';
}

export function formatExplorerPaths(paths,format) {
  if (format === 'windows') return paths.map(windowsArgument).join(' ');
  if (format === 'powershell') {
    const quoted = paths.map(path => "'" + path.replaceAll("'", "''") + "'");
    return quoted.length === 1 ? quoted[0] : '@(' + quoted.join(', ') + ')';
  }
  if (format === 'json') return JSON.stringify(paths.length === 1 ? paths[0] : paths,null,2);
  return paths.join('\n');
}
