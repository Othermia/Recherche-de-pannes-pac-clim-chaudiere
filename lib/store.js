import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
export const DOCS_DIR = path.join(DATA_DIR, "docs");
export const TEXT_DIR = path.join(DATA_DIR, "text");
const DB_FILE = path.join(DATA_DIR, "db.json");

for (const dir of [DATA_DIR, DOCS_DIR, TEXT_DIR]) fs.mkdirSync(dir, { recursive: true });

let db = { equipements: [], docs: [] };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };

function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomBytes(8).toString("hex");

export function list(collection) {
  return db[collection];
}

export function get(collection, id) {
  return db[collection].find((x) => x.id === id);
}

export function insert(collection, item) {
  const record = { ...item, id: newId(), createdAt: new Date().toISOString() };
  db[collection].unshift(record);
  save();
  return record;
}

export function update(collection, id, patch) {
  const item = get(collection, id);
  if (!item) return null;
  Object.assign(item, patch, { id, updatedAt: new Date().toISOString() });
  save();
  return item;
}

export function remove(collection, id) {
  const before = db[collection].length;
  db[collection] = db[collection].filter((x) => x.id !== id);
  if (db[collection].length !== before) save();
  return db[collection].length !== before;
}
