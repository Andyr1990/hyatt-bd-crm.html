const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// If a Railway Volume is mounted, point DATA_DIR at it (e.g. /data) so the
// store survives redeploys. Without one, this still persists across normal
// use (refreshes, closing the tab, coming back later) -- it just resets on
// a fresh deploy since the container filesystem is rebuilt.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}));

function readStore() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function writeStore(store) {
  fs.writeFileSync(DB_FILE, JSON.stringify(store));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

/* ===================== generic key/value storage API =====================
   Mirrors the shape the CRM frontend expects: GET/PUT a JSON blob by key. */

app.get('/api/storage/:key', (req, res) => {
  const store = readStore();
  const key = req.params.key;
  if (!(key in store)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: store[key] });
});

app.put('/api/storage/:key', (req, res) => {
  const store = readStore();
  const key = req.params.key;
  store[key] = req.body.value;
  writeStore(store);
  res.json({ key, value: store[key] });
});

app.delete('/api/storage/:key', (req, res) => {
  const store = readStore();
  delete store[req.params.key];
  writeStore(store);
  res.json({ deleted: true });
});

/* ===================== Dripify / Zapier webhook =====================
   Point a Zapier or Make automation at:
     POST https://<your-domain>/api/webhooks/dripify

   Dripify doesn't publish an open developer API -- its supported path
   out is Zapier/Make. Build a Zap triggered on a Dripify event (new
   connection, reply received, etc.) with a "Webhook by Zapier" action
   pointed at the URL above, and map these fields in the JSON body:

     { "name": "...", "email": "...", "linkedinUrl": "...",
       "company": "...", "message": "...", "event": "..." }

   Only name / email / linkedinUrl need at least one to be present.
   Matching is done by email first, then LinkedIn URL. A new lead is
   created on the "New Lead" pipeline stage if no match is found, and
   the message/event is logged as a Conversation entry on that contact. */

app.post('/api/webhooks/dripify', (req, res) => {
  const { name, email, linkedinUrl, message, event } = req.body || {};

  if (!name && !email && !linkedinUrl) {
    return res.status(400).json({ error: 'Provide at least a name, email, or linkedinUrl' });
  }

  const store = readStore();
  const contacts = store['inflate_crm_contacts'] ? JSON.parse(store['inflate_crm_contacts']) : [];
  const conversations = store['inflate_crm_conversations'] ? JSON.parse(store['inflate_crm_conversations']) : [];

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  let contact = contacts.find(c =>
    (email && c.email && c.email.toLowerCase() === String(email).toLowerCase()) ||
    (linkedinUrl && c.linkedin && c.linkedin === linkedinUrl)
  );

  if (!contact) {
    contact = {
      id: uid('lead'),
      name: name || email || 'LinkedIn contact',
      title: '',
      companyId: null,
      email: email || '',
      phone: '',
      linkedin: linkedinUrl || '',
      stage: 'new',
      dealValue: 0,
      tags: ['dripify'],
      notes: '',
      isLost: false,
      createdAt: new Date().toISOString()
    };
    contacts.push(contact);
  }

  conversations.push({
    id: uid('conv'),
    contactId: contact.id,
    type: 'note',
    date: new Date().toISOString().slice(0, 10),
    summary: 'LinkedIn (Dripify): ' + (message || (event ? ('event — ' + event) : 'activity logged'))
  });

  store['inflate_crm_contacts'] = JSON.stringify(contacts);
  store['inflate_crm_conversations'] = JSON.stringify(conversations);
  writeStore(store);

  res.json({ ok: true, contactId: contact.id, created: !contacts.some(c => c.id !== contact.id) });
});

app.get('/api/health', (req, res) => res.json({ ok: true, storage: DATA_DIR }));

app.listen(PORT, () => console.log('HYATT BD Crm server running on port ' + PORT));
