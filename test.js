/**
 * Encosta (Touch?) — Automated Test Suite
 * 20 comprehensive tests covering all major features
 * Run: node test.js
 */

const http = require('http');

const BASE = 'http://localhost:' + (process.env.PORT || 3000);
let passed = 0, failed = 0, total = 0;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; }
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + total + '. ' + name);
  } catch (e) {
    failed++;
    console.log('  ❌ ' + total + '. ' + name + ' — ' + e.message);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

const testNick1 = 'TestUser_' + Date.now();
const testNick2 = 'TestUser2_' + Date.now();
let userId1, userId2;

async function run() {
  console.log('\n🧪 Encosta Test Suite — 20 tests\n');

  // 1. Register user 1
  await test('Register user 1', async () => {
    const r = await req('POST', '/api/register', { nickname: testNick1, birthdate: '1995-06-15' });
    assert(r.status === 200 || r.status === 201, 'Status: ' + r.status);
    assert(r.body.userId, 'No userId returned');
    userId1 = r.body.userId;
  });

  // 2. Register user 2
  await test('Register user 2', async () => {
    const r = await req('POST', '/api/register', { nickname: testNick2, birthdate: '1990-03-20' });
    assert(r.body.userId, 'No userId returned');
    userId2 = r.body.userId;
  });

  // 3. Profile
  await test('Get my profile', async () => {
    const r = await req('GET', '/api/myprofile/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(r.body.nickname === testNick1, 'Wrong nickname: ' + r.body.nickname);
    assert(typeof r.body.score === 'number', 'No score');
  });

  // 4. Update profile
  await test('Update profile', async () => {
    const r = await req('POST', '/api/profile/update', { userId: userId1, realName: 'Test Name', bio: 'Bio' });
    assert(r.status === 200, 'Status: ' + r.status);
  });

  // 5. Constellation
  await test('Get constellation', async () => {
    const r = await req('GET', '/api/constellation/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(Array.isArray(r.body.nodes), 'No nodes');
    assert(Array.isArray(r.body.links), 'No links');
  });

  // 6. Score
  await test('Get score', async () => {
    const r = await req('GET', '/api/score/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(typeof r.body.score === 'number', 'No score');
  });

  // 7. Stars detail
  await test('Get stars', async () => {
    const r = await req('GET', '/api/stars/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(Array.isArray(r.body.stars), 'No stars');
  });

  // 8. Star shop
  await test('Star shop info', async () => {
    const r = await req('GET', '/api/star/shop/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(typeof r.body.selfCost === 'number', 'No selfCost');
  });

  // 9. Pending stars
  await test('Pending stars empty', async () => {
    const r = await req('GET', '/api/star/pending/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(r.body.count === 0, 'Should be 0 pending');
  });

  // 10. Star donate fails without stars
  await test('Star donate fails', async () => {
    const r = await req('POST', '/api/star/donate', { fromUserId: userId1, toUserId: userId2 });
    assert(r.status === 400, 'Should fail: ' + r.status);
  });

  // 11. Self-donate fails
  await test('Self-donate fails', async () => {
    const r = await req('POST', '/api/star/donate', { fromUserId: userId1, toUserId: userId1 });
    assert(r.status === 400, 'Should reject self');
  });

  // 12. Search people
  await test('Search people by nick', async () => {
    const r = await req('GET', '/api/star/search-people/' + userId1 + '?q=' + testNick2.slice(0, 10));
    assert(r.status === 200, 'Status: ' + r.status);
    assert(r.body.results.length >= 1, 'Should find user2');
  });

  // 13. Notifications
  await test('Get notifications', async () => {
    const r = await req('GET', '/api/notifications/' + userId1);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(typeof r.body.unseenCount === 'number', 'No unseenCount');
  });

  // 14. Mark seen
  await test('Mark notifications seen', async () => {
    const r = await req('POST', '/api/notifications/seen', { userId: userId1 });
    assert(r.body.ok, 'Not ok');
    const r2 = await req('GET', '/api/notifications/' + userId1);
    assert(r2.body.unseenCount === 0, 'Should be 0 unseen');
  });

  // 15. Reveal identity
  await test('Reveal identity', async () => {
    const r = await req('POST', '/api/identity/reveal', { userId: userId1, targetUserId: userId2 });
    assert(r.status === 200, 'Status: ' + r.status);
  });

  // 16. Toggle reveal off (hide)
  await test('Hide identity (toggle off)', async () => {
    const r = await req('POST', '/api/reveal/toggle', { userId: userId1, partnerId: userId2, reveal: false });
    assert(r.status === 200, 'Status: ' + r.status);
  });

  // 17. Request reveal
  await test('Request reveal', async () => {
    const r = await req('POST', '/api/identity/request-reveal', { userId: userId1, targetUserId: userId2 });
    assert(r.status === 200, 'Status: ' + r.status);
  });

  // 18. Declarations
  await test('Send declaration', async () => {
    const r = await req('POST', '/api/declarations/send', { fromUserId: userId1, toUserId: userId2, text: 'Pessoa incrivel!' });
    assert(r.status === 200 || r.status === 201, 'Status: ' + r.status);
  });

  // 19. Get declarations
  await test('Get declarations', async () => {
    const r = await req('GET', '/api/declarations/' + userId2);
    assert(r.status === 200, 'Status: ' + r.status);
    assert(r.body.declarations.length >= 1, 'No declarations');
  });

  // 20. Doc ID submit
  await test('Doc ID submit + status', async () => {
    const r = await req('POST', '/api/doc/submit', {
      userId: userId1, docPhoto: 'data:image/png;base64,iVBOR', selfiePhoto: 'data:image/png;base64,iVBOR',
      docName: 'Test', cpf: '123.456.789-00'
    });
    assert(r.status === 200, 'Status: ' + r.status);
    const r2 = await req('GET', '/api/doc/status/' + userId1);
    assert(r2.body.status === 'pending', 'Wrong status: ' + r2.body.status);
  });

  console.log('\n' + '='.repeat(40));
  console.log('  Total: ' + total + '  ✅ Passed: ' + passed + '  ❌ Failed: ' + failed);
  console.log('='.repeat(40) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
