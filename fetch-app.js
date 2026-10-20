// Downloads the Spacer simulator build for screenshots from EAS.
//
//   EXPO_TOKEN=… node fetch-app.js [build id] > app.tar.gz
//
// With an id it waits for that build to finish (EAS free builds can queue for a
// while). Without one it takes the newest finished "screenshots" build.
const PROJECT = 'c6c44bd2-358d-4576-96b3-02502534feff';
const WAIT_MINUTES = 230;
const fs = require('fs');

async function gql(query, variables) {
  const res = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.EXPO_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

const byId = id => gql('query($id: ID!) { builds { byId(buildId: $id) { id status artifacts { buildUrl } } } }', { id }).then(d => d.builds.byId);
const newest = () => gql(`query($appId: String!, $filter: BuildFilter) {
  app { byId(appId: $appId) { builds(offset: 0, limit: 1, filter: $filter) { id status artifacts { buildUrl } } } } }`,
  { appId: PROJECT, filter: { platform: 'IOS', buildProfile: 'screenshots', status: 'FINISHED' } }).then(d => d.app.byId.builds[0]);

(async () => {
  if (!process.env.EXPO_TOKEN) throw new Error('EXPO_TOKEN is not set');
  const id = process.argv[2];
  let build;
  for (let minute = 0; ; minute++) {
    build = id ? await byId(id) : await newest();
    if (!build) throw new Error('No finished screenshots build on EAS yet. Start one with: eas build -p ios --profile screenshots');
    if (build.status === 'FINISHED') break;
    if (['ERRORED', 'CANCELED', 'PENDING_CANCEL'].includes(build.status)) throw new Error(`EAS build ${build.id} ${build.status}`);
    if (minute >= WAIT_MINUTES) throw new Error(`EAS build ${build.id} still ${build.status} after ${WAIT_MINUTES} minutes`);
    if (minute % 10 === 0) console.error(`EAS build ${build.id}: ${build.status}, waiting`);
    await new Promise(r => setTimeout(r, 60_000));
  }
  console.error(`EAS build ${build.id}: finished, downloading`);
  const res = await fetch(build.artifacts.buildUrl);
  if (!res.ok) throw new Error(`download -> ${res.status}`);
  fs.writeFileSync(1, Buffer.from(await res.arrayBuffer()));
})().catch(e => { console.error(e.message); process.exit(1); });
