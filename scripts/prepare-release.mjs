import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

const sourceRoot = new URL('../', import.meta.url);
const tag = process.env.GITHUB_REF_NAME || '';
const version = tag.match(/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/)?.[1];
const repo = process.env.GITHUB_REPOSITORY || '';
const [command,filename] = process.argv.slice(2);

async function verifySourceVersion() {
  if (!version) throw Error('The release tag must be a stable version such as v0.10.44.');
  const [manifest,config] = await Promise.all([
    readFile(new URL('src-tauri/Cargo.toml', sourceRoot), 'utf8'),
    readFile(new URL('src-tauri/tauri.conf.json', sourceRoot), 'utf8').then(JSON.parse),
  ]);
  const packageSection = manifest.split(/^\[/m).find(section => section.startsWith('package]'));
  const cargoVersion = packageSection?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (cargoVersion !== version || config.version !== version) {
    throw Error(`Tag ${tag} disagrees with Cargo.toml (${cargoVersion}) or tauri.conf.json (${config.version}).`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]+$/i.test(repo)) {
    throw Error('GITHUB_REPOSITORY must contain a GitHub owner and repository name.');
  }
}

function updaterPublicKey() {
  const pubkey = process.env.NEXUS_UPDATER_PUBLIC_KEY?.trim();
  if (!pubkey || !/^[a-z0-9+/]+={0,2}$/i.test(pubkey)) {
    throw Error('Set NEXUS_UPDATER_PUBLIC_KEY to the content of the Tauri signing public key file.');
  }
  const [comment, encodedKey, ...trailing] = Buffer.from(pubkey, 'base64').toString().trim().split(/\r?\n/);
  const key = Buffer.from(encodedKey || '', 'base64');
  if (!comment.startsWith('untrusted comment:') || trailing.length || key.length !== 42 ||
      key.subarray(0, 2).toString() !== 'Ed') {
    throw Error('NEXUS_UPDATER_PUBLIC_KEY must contain a Tauri minisign public key.');
  }
  return {pubkey,keyId:key.subarray(2, 10)};
}

async function writeConfig() {
  const updater = {
    pubkey:updaterPublicKey().pubkey,
    endpoints:[`https://github.com/${repo}/releases/latest/download/latest.json`],
    requireSignedVersion:true,
  };
  const config = {bundle:{createUpdaterArtifacts:true},plugins:{updater}};
  const output = resolve(filename);
  await mkdir(dirname(output), {recursive:true});
  await writeFile(output, JSON.stringify(config, null, 2) + '\n');
}

async function verifyManifest() {
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  const target = manifest.platforms?.['windows-x86_64'];
  const installer = `https://github.com/${repo}/releases/download/${tag}/nexus-assets-${version}-windows-x64-setup.exe`;
  const assetApi = `https://api.github.com/repos/${repo}/releases/assets/`;
  const url = target?.url || '';
  const knownSource = url === installer || (url.startsWith(assetApi) && /^\d+$/.test(url.slice(assetApi.length)));
  if (String(manifest.version).replace(/^v/, '') !== version || !knownSource) {
    throw Error('latest.json does not point to this tagged Windows x64 installer.');
  }
  const signature = Buffer.from(target.signature || '', 'base64').toString('utf8');
  const [,encodedSignature = '',comment = ''] = signature.split(/\r?\n/);
  const signed = Buffer.from(encodedSignature, 'base64');
  if (signed.length !== 74 || !signed.subarray(2, 10).equals(updaterPublicKey().keyId) ||
      !comment.startsWith('trusted comment:') || !comment.split(/\s+/).includes(`version:${version}`)) {
    throw Error('latest.json does not include an updater signature bound to the tagged version.');
  }
}

if (!filename || !['config','verify'].includes(command)) {
  throw Error('Usage: node scripts/prepare-release.mjs <config|verify> <file>.');
}
await verifySourceVersion();
if (command === 'config') await writeConfig();
else await verifyManifest();
