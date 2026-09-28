import Database from 'better-sqlite3';
import { config } from '../config';

export const getDb = (dbPath: string = config.DATABASE_URL) => {
  const db = new Database(dbPath, {
    verbose: config.NODE_ENV === 'development' ? console.log : undefined,
  });

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  return db;
};
