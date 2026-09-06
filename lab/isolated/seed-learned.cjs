// Seed derived numeric surfaces only into an empty candidate database.
// Never point this script at an existing archive.
const fs=require('fs');
const Database=require('better-sqlite3');
const database=process.env.LAB_DB;
if(!database||!process.argv[2])throw Error('LAB_DB and aggregate JSON path required');
if(fs.existsSync(database)&&fs.statSync(database).size>0)throw Error('Refusing to seed an existing database');
const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(data.kind!=='numeric-learned-aggregates')throw Error('Unexpected aggregate format');
const tables=new Set(['seg','segShape','route','global','stopDwell','stopRelease','corridor','corridorPace']);
for(const row of data.rows){if(row.length!==7||!tables.has(row[0])||typeof row[1]!=='string'||!row.slice(2).every(Number.isFinite))throw Error('Invalid aggregate row');}
const db=new Database(database);
db.exec('CREATE TABLE learned_cells (tbl TEXT NOT NULL,cellKey TEXT NOT NULL,mean REAL NOT NULL,weight REAL NOT NULL,s REAL NOT NULL,n INTEGER NOT NULL,updatedAtMs INTEGER NOT NULL,PRIMARY KEY(tbl,cellKey))');
const insert=db.prepare('INSERT INTO learned_cells VALUES (?,?,?,?,?,?,?)');
db.transaction(()=>{for(const row of data.rows)insert.run(...row);})();
db.close();
console.log(`Seeded ${data.rows.length} derived surfaces; no fixes, identities, scores or archives imported`);
