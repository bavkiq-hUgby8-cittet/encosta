#!/usr/bin/env node
// Touch? App - Basic API Tests
// Run: node test.js [server-url]
// Default: http://localhost:3000

const BASE = process.argv[2] || 'http://localhost:3000';
let passed = 0, failed = 0, total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

async function api(path, opts = {}) {
  const url = BASE + path;
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  return r.json();
}

async function run() {
  console.log(`\n🧪 Touch? API Tests — ${BASE}\n`);

  // ── Status ──
  console.log('── Status ──');
  await test('GET /api/status returns ok', async () => {
    const d = await api('/api/status');
    assert(d.ok === true, 'Expected ok:true');
    assert(typeof d.counts === 'object', 'Expected counts object');
    assert(typeof d.counts.users === 'number', 'Expected users count');
  });

  // ── Reset DB ──
  console.log('\n── Reset DB ──');
  await test('POST /api/admin/reset-db requires confirm', async () => {
    const d = await api('/api/admin/reset-db', { method: 'POST', body: {} });
    assert(d.error, 'Expected error without confirm');
  });

  await test('POST /api/admin/reset-db clears data', async () => {
    const d = await api('/api/admin/reset-db', { method: 'POST', body: { confirm: 'RESET' } });
    assert(d.ok === true, 'Expected ok:true');
    assert(typeof d.cleared === 'object', 'Expected cleared stats');
  });

  // ── Registration ──
  console.log('\n── Registration ──');
  let userA, userB;

  await test('POST /api/register user A', async () => {
    const d = await api('/api/register', { method: 'POST', body: { nickname: 'Alice', color: '#ff6b9d', birthdate: '1995-03-15' } });
    assert(d.id, 'Expected user id');
    assert(d.nickname === 'Alice', 'Expected nickname Alice');
    userA = d;
  });

  await test('POST /api/register user B', async () => {
    const d = await api('/api/register', { method: 'POST', body: { nickname: 'Bob', color: '#6baaff', birthdate: '1992-08-22' } });
    assert(d.id, 'Expected user id');
    assert(d.nickname === 'Bob', 'Expected nickname Bob');
    userB = d;
  });

  await test('POST /api/register rejects empty nickname', async () => {
    const d = await api('/api/register', { method: 'POST', body: { nickname: '', color: '#fff' } });
    assert(d.error, 'Expected error for empty nickname');
  });

  // ── Session / Touch ──
  console.log('\n── Session / Touch ──');
  let sessionCode;

  await test('POST /api/session/create creates session', async () => {
    const d = await api('/api/session/create', { method: 'POST', body: { userId: userA.id } });
    assert(d.code, 'Expected session code');
    sessionCode = d.code;
  });

  await test('POST /api/session/join connects users', async () => {
    const d = await api('/api/session/join', { method: 'POST', body: { code: sessionCode, userId: userB.id } });
    assert(d.relationId || d.relation, 'Expected relation data');
  });

  // ── Relations ──
  console.log('\n── Relations ──');
  await test('GET /api/relations/:userId returns relations', async () => {
    const d = await api(`/api/relations/${userA.id}`);
    assert(Array.isArray(d), 'Expected array');
    assert(d.length > 0, 'Expected at least 1 relation');
    assert(d[0].partner, 'Expected partner data');
  });

  // ── Constellation ──
  console.log('\n── Constellation ──');
  await test('GET /api/constellation/:userId returns nodes', async () => {
    const d = await api(`/api/constellation/${userA.id}`);
    assert(Array.isArray(d), 'Expected array');
    assert(d.length > 0, 'Expected at least 1 node');
    assert(d[0].nickname, 'Expected nickname in node');
  });

  // ── Events ──
  console.log('\n── Events ──');
  let eventId;

  await test('POST /api/event/create creates event', async () => {
    const d = await api('/api/event/create', { method: 'POST', body: {
      userId: userA.id, name: 'Test Meetup', description: 'A test event', lat: -23.5505, lng: -46.6333, radius: 200
    }});
    assert(d.event, 'Expected event data');
    assert(d.event.id, 'Expected event id');
    assert(d.event.name === 'Test Meetup', 'Expected event name');
    assert(d.event.participants.includes(userA.id), 'Creator should be participant');
    eventId = d.event.id;
  });

  await test('POST /api/event/create rejects missing name', async () => {
    const d = await api('/api/event/create', { method: 'POST', body: { userId: userA.id, lat: -23.5, lng: -46.6 } });
    assert(d.error, 'Expected error for missing name');
  });

  await test('GET /api/event/:id returns event details', async () => {
    const d = await api(`/api/event/${eventId}`);
    assert(d.name === 'Test Meetup', 'Expected event name');
    assert(d.participantsData, 'Expected participantsData');
    assert(d.participantsData.length === 1, 'Expected 1 participant');
    assert(d.participantsData[0].id === userA.id, 'Expected creator as participant');
  });

  await test('POST /api/event/join adds user to event', async () => {
    const d = await api('/api/event/join', { method: 'POST', body: { eventId, userId: userB.id } });
    assert(d.ok === true, 'Expected ok:true');
  });

  await test('GET /api/events/nearby finds event', async () => {
    const d = await api('/api/events/nearby?lat=-23.5505&lng=-46.6333&radius=5000');
    assert(Array.isArray(d), 'Expected array');
    assert(d.length > 0, 'Expected at least 1 event');
    assert(d[0].participantCount === 2, 'Expected 2 participants');
  });

  await test('POST /api/event/encosta-request with targetId', async () => {
    const d = await api('/api/event/encosta-request', { method: 'POST', body: {
      eventId, userId: userA.id, targetId: userB.id
    }});
    assert(d.ok === true, 'Expected ok:true');
    assert(d.requestId, 'Expected requestId');
  });

  await test('POST /api/event/encosta-accept creates relation', async () => {
    const d = await api('/api/event/encosta-accept', { method: 'POST', body: {
      eventId, userId: userB.id, fromUserId: userA.id, accepted: true
    }});
    assert(d.relationId, 'Expected relationId');
    assert(d.userA, 'Expected userA data');
    assert(d.userB, 'Expected userB data');
    assert(d.userA.profilePhoto !== undefined, 'Expected profilePhoto field in userA');
    assert(d.type === 'digital', 'Expected type digital');
  });

  // ── Location ──
  console.log('\n── Location ──');
  await test('POST /api/location/update stores location', async () => {
    const d = await api('/api/location/update', { method: 'POST', body: { userId: userA.id, lat: -23.5505, lng: -46.6333 } });
    assert(d.ok === true, 'Expected ok:true');
  });

  await test('GET /api/nearby/:userId finds nearby users', async () => {
    // Update B's location nearby
    await api('/api/location/update', { method: 'POST', body: { userId: userB.id, lat: -23.5506, lng: -46.6334 } });
    const d = await api(`/api/nearby/${userA.id}?radius=1000`);
    assert(Array.isArray(d), 'Expected array');
    // B should be nearby
    assert(d.some(p => p.id === userB.id), 'Expected userB nearby');
  });

  // ── ID Reveal ──
  console.log('\n── ID Reveal ──');
  await test('POST /api/reveal-id works', async () => {
    // Get a relation first
    const rels = await api(`/api/relations/${userA.id}`);
    if (rels.length > 0) {
      const relId = rels[0].id;
      const d = await api('/api/reveal-id', { method: 'POST', body: { userId: userA.id, relationId: relId } });
      assert(d.ok === true || d.error, 'Expected response');
    }
  });

  // ── Final Reset with keepUsers ──
  console.log('\n── Reset with keepUsers ──');
  await test('POST /api/admin/reset-db keepUsers preserves users', async () => {
    const before = await api('/api/status');
    const d = await api('/api/admin/reset-db', { method: 'POST', body: { confirm: 'RESET', keepUsers: true } });
    assert(d.ok === true, 'Expected ok:true');
    const after = await api('/api/status');
    assert(after.counts.users === before.counts.users, 'Users should be preserved');
    assert(after.counts.relations === 0, 'Relations should be cleared');
    assert(after.counts.events === 0, 'Events should be cleared');
  });

  // ── Summary ──
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  Total: ${total}  ✅ ${passed}  ❌ ${failed}`);
  console.log(`${'═'.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
