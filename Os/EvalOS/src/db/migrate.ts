import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';

export function runMigrations(db: Database) {
  // Ensure migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const getExecuted = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  const executedSet = new Set(getExecuted.map(row => row.name));

  for (const file of files) {
    if (!executedSet.has(file)) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      
      const transaction = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      });
      
      transaction();
      console.log(`Applied migration: ${file}`);
    }
  }
}
