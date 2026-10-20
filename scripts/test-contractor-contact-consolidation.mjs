import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "20261103_contractor_contact_consolidation.sql"),
  "utf8",
);

assert.match(migration, /create_count IS DISTINCT FROM 163/);
assert.match(migration, /review_required_count IS DISTINCT FROM 155/);
assert.match(migration, /source_record_count IS DISTINCT FROM 318/);
const fixtureMigration = migration
  .replaceAll("163", "7")
  .replaceAll("155", "4")
  .replaceAll("318", "11")
  .replace("IS DISTINCT FROM 2::BIGINT", "IS DISTINCT FROM 3::BIGINT");

async function main() {
  const db = await PGlite.create();
  try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE contractors (
      id INTEGER PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT,
      email TEXT,
      phone TEXT
    );
    CREATE TABLE contractor_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      contractor_id INTEGER NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
      contact_name TEXT NOT NULL CHECK (contact_name ~ '[^[:space:]]'),
      title_or_role TEXT,
      email TEXT,
      mobile_phone TEXT,
      is_primary_contact BOOLEAN NOT NULL DEFAULT FALSE,
      is_compliance_contact BOOLEAN NOT NULL DEFAULT FALSE,
      receives_compliance_email BOOLEAN NOT NULL DEFAULT FALSE,
      receives_compliance_sms BOOLEAN NOT NULL DEFAULT FALSE,
      sms_consent_recorded BOOLEAN NOT NULL DEFAULT FALSE,
      sms_consent_date DATE,
      sms_consent_source_or_note TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO contractors VALUES
      (1, 'Name and Email', 'Ada Example', 'ada@example.invalid', NULL),
      (2, 'Name Only', 'Ben Example', NULL, NULL),
      (3, 'Name Email Phone', 'Cy Example', 'cy@example.invalid', '+1 555 0103'),
      (4, 'Name Phone', 'Dee Example', NULL, '+1 555 0104'),
      (5, 'Email Only', NULL, 'email-only@example.invalid', NULL),
      (6, 'Email Phone', NULL, 'email-phone@example.invalid', '+1 555 0106'),
      (7, 'Phone Only', NULL, NULL, '+1 555 0107'),
      (8, 'Unrelated Existing Contact', 'Eli Example', 'eli@example.invalid', NULL),
      (9, 'Same Contractor Duplicate', 'Fay Example', 'fay@example.invalid', NULL),
      (10, 'Changed During Migration', 'Gia Example', 'gia@example.invalid', '+1 555 0110'),
      (11, 'Cross Contractor Match', 'Ada Example', 'ada@example.invalid', NULL),
      (12, 'Other Contractor', NULL, NULL, NULL);
    INSERT INTO contractor_contacts (
      id, contractor_id, contact_name, email, mobile_phone
    ) VALUES
      ('00000000-0000-0000-0000-000000000801', 8, 'Unrelated Person', 'other@example.invalid', NULL),
      ('00000000-0000-0000-0000-000000000901', 9, 'Fay Example', 'fay@example.invalid', NULL),
      ('00000000-0000-0000-0000-000000000121', 12, 'Ada Example', 'ada@example.invalid', NULL);
  `);

  const existingContactsBefore = (await db.query(
    "SELECT id, to_jsonb(contact) AS row FROM contractor_contacts AS contact ORDER BY id",
  )).rows;
  await db.exec(`
    CREATE FUNCTION mutate_legacy_contact_during_insert()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.contractor_id = 10 THEN
        UPDATE contractors
        SET contact_name = 'Gia Changed', email = 'gia.changed@example.invalid'
        WHERE id = 10;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER mutate_legacy_contact_during_insert
    BEFORE INSERT ON contractor_contacts
    FOR EACH ROW EXECUTE FUNCTION mutate_legacy_contact_during_insert();
  `);

  await assert.rejects(
    db.exec(fixtureMigration),
    /Legacy Contractor values changed during conversion/,
    "a source change after classification must abort the entire migration transaction",
  );
  await db.exec("ROLLBACK").catch(() => {});
  assert.equal(
    (await db.query("SELECT to_regclass('public.contractor_contact_consolidation_runs') AS table_name")).rows[0].table_name,
    null,
    "failed transaction must not leave migration metadata",
  );
  assert.deepEqual(
    (await db.query("SELECT contact_name, email, phone FROM contractors WHERE id=10")).rows[0],
    {
      contact_name: "Gia Example",
      email: "gia@example.invalid",
      phone: "+1 555 0110",
    },
    "source changes made during the failed migration must roll back",
  );
  assert.equal(
    (await db.query("SELECT count(*)::INTEGER AS count FROM contractor_contacts")).rows[0].count,
    3,
    "failed transaction must not leave created Contacts",
  );
  await db.exec(`
    DROP TRIGGER mutate_legacy_contact_during_insert ON contractor_contacts;
    DROP FUNCTION mutate_legacy_contact_during_insert();
  `);

  await db.exec(fixtureMigration);
  assert.deepEqual(
    (await db.query(`
      SELECT classification, count(*)::INTEGER AS count
      FROM contractor_contact_consolidation_lineage
      GROUP BY classification ORDER BY classification
    `)).rows,
    [
      { classification: "CREATE", count: 7 },
      { classification: "REVIEW_REQUIRED", count: 4 },
    ],
  );
  assert.deepEqual(
    (await db.query(`
      SELECT migration_name, create_count, review_required_count, source_record_count
      FROM contractor_contact_consolidation_runs
    `)).rows[0],
    {
      migration_name: "20261103_contractor_contact_consolidation",
      create_count: 7,
      review_required_count: 4,
      source_record_count: 11,
    },
  );

  const created = (await db.query(`
    SELECT lineage.contractor_id, lineage.source_contact_name,
           lineage.source_email, lineage.source_phone,
           lineage.contractor_contact_id, contact.contact_name,
           contact.email, contact.mobile_phone, contact.title_or_role,
           contact.is_primary_contact, contact.is_compliance_contact,
           contact.receives_compliance_email, contact.receives_compliance_sms,
           contact.sms_consent_recorded, contact.sms_consent_date,
           contact.sms_consent_source_or_note
    FROM contractor_contact_consolidation_lineage AS lineage
    JOIN contractor_contacts AS contact
      ON contact.id = lineage.contractor_contact_id
     AND contact.contractor_id = lineage.contractor_id
    WHERE lineage.classification = 'CREATE'
    ORDER BY lineage.contractor_id
  `)).rows;
  assert.deepEqual(created.map((row) => row.contractor_id), [1, 2, 3, 4, 8, 10, 11]);
  for (const row of created) {
    assert.equal(row.contact_name, row.source_contact_name.trim());
    assert.equal(row.email, row.source_email?.trim() || null);
    assert.equal(row.mobile_phone, null, "contractors.phone must never map to mobile_phone");
    assert.equal(row.title_or_role, null);
    assert.equal(row.is_primary_contact, false);
    assert.equal(row.is_compliance_contact, false);
    assert.equal(row.receives_compliance_email, false);
    assert.equal(row.receives_compliance_sms, false);
    assert.equal(row.sms_consent_recorded, false);
    assert.equal(row.sms_consent_date, null);
    assert.equal(row.sms_consent_source_or_note, null);
  }
  assert.equal(
    (await db.query(`
      SELECT count(*)::INTEGER AS count
      FROM contractor_contact_consolidation_lineage
      WHERE classification = 'REVIEW_REQUIRED' AND contractor_contact_id IS NOT NULL
    `)).rows[0].count,
    0,
    "review-required records must not create Contacts",
  );
  assert.equal(
    (await db.query(`
      SELECT count(*)::INTEGER AS count
      FROM contractor_contacts
      WHERE contractor_id = 11 AND contact_name = 'Ada Example'
    `)).rows[0].count,
    1,
    "a similar Contact under a different Contractor must not be treated as a duplicate",
  );
  assert.deepEqual(
    (await db.query(`
      SELECT id, to_jsonb(contact) AS row FROM contractor_contacts
      AS contact
      WHERE id IN (
        '00000000-0000-0000-0000-000000000801',
        '00000000-0000-0000-0000-000000000901',
        '00000000-0000-0000-0000-000000000121'
      )
      ORDER BY id
    `)).rows,
    existingContactsBefore,
    "all pre-existing Contacts must remain unchanged",
  );
  assert.equal(
    (await db.query(`
      SELECT count(*)::INTEGER AS count
      FROM contractor_contact_consolidation_lineage AS lineage
      JOIN contractors AS source ON source.id = lineage.contractor_id
      WHERE source.contact_name IS DISTINCT FROM lineage.source_contact_name
         OR source.email IS DISTINCT FROM lineage.source_email
         OR source.phone IS DISTINCT FROM lineage.source_phone
    `)).rows[0].count,
    0,
    "legacy Contractor fields must remain exact",
  );
  assert.equal(
    (await db.query(`
      SELECT count(*)::INTEGER AS count
      FROM contractor_contact_consolidation_lineage
      WHERE classification = 'CREATE' AND source_phone IS NOT NULL
    `)).rows[0].count,
    3,
    "the named phone-bearing test records remain lineage-only phone sources",
  );

  await db.exec(fixtureMigration);
  assert.equal(
    (await db.query("SELECT count(*)::INTEGER AS count FROM contractor_contacts")).rows[0].count,
    10,
    "rerunning the migration must not create duplicates",
  );

  const manuallyCreated = (await db.query(`
    INSERT INTO contractor_contacts (contractor_id, contact_name, email)
    VALUES (1, 'Manually Created', 'manual@example.invalid')
    RETURNING id
  `)).rows[0].id;
  await db.query(`
    UPDATE contractor_contacts
    SET contact_name = 'User Edited'
    WHERE id = (
      SELECT contractor_contact_id
      FROM contractor_contact_consolidation_lineage
      WHERE contractor_id = 1
    )
  `);
  assert.deepEqual(
    (await db.query("SELECT * FROM rollback_contractor_contact_consolidation()")).rows[0],
    { deleted: 6, skipped_modified: 1, already_absent: 0 },
  );
  assert.equal(
    (await db.query("SELECT count(*)::INTEGER AS count FROM contractor_contacts WHERE id = $1", [manuallyCreated])).rows[0].count,
    1,
    "rollback must preserve a manually created Contact",
  );
  assert.deepEqual(
    (await db.query(`
      SELECT count(*) FILTER (WHERE id IN (
        '00000000-0000-0000-0000-000000000801',
        '00000000-0000-0000-0000-000000000901',
        '00000000-0000-0000-0000-000000000121'
      ))::INTEGER AS existing_count,
      count(*) FILTER (WHERE contractor_id IN (5, 6, 7))::INTEGER AS review_contact_count
      FROM contractor_contacts
    `)).rows[0],
    { existing_count: 3, review_contact_count: 0 },
  );
  assert.equal(
    (await db.query(`
      SELECT migration_status FROM contractor_contact_consolidation_lineage
      WHERE contractor_id = 1
    `)).rows[0].migration_status,
    "ROLLBACK_SKIPPED_MODIFIED",
  );
  assert.deepEqual(
    (await db.query("SELECT * FROM rollback_contractor_contact_consolidation()")).rows[0],
    { deleted: 0, skipped_modified: 0, already_absent: 0 },
    "rerunning rollback must be a no-op",
  );

  await db.exec("BEGIN; SET LOCAL ROLE anon;");
  await assert.rejects(
    db.query("SELECT * FROM contractor_contact_consolidation_lineage"),
    /permission denied|row-level security/i,
    "restricted lineage must not be readable by anonymous users",
  );
  await db.exec("ROLLBACK;");

  console.log("PASS: one-phase migration snapshot, count assertions, conversion, lineage, and preservation checks are atomic");
  console.log("PASS: named/email mapping, unnamed review, duplicate and cross-Contractor guards, and no phone/SMS/role inference");
  console.log("PASS: repeat migration is idempotent; rollback deletes only unchanged lineage-linked Contacts");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
});
