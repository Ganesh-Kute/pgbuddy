// @vitest-environment node
//
// Storage access rules for tenant files (S-10, S-11), run as real Postgres row-level security in PGlite.
// Before the fix any signed-in user could read, overwrite and delete every tenant's ID proof and payment
// proof. Each case signs in as a user (role authenticated + JWT sub) and tries the operation.

import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
import path from "path";

const MIGRATION = path.resolve(__dirname, "../../supabase/migrations/20261122160000_private_storage_rls.sql");

// Just enough of auth, storage and the app schema, with the open policies that were live before.
const BASE = `
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE anon NOLOGIN;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO authenticated, anon;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.properties (id uuid PRIMARY KEY, owner_id uuid NOT NULL);
  CREATE TABLE public.staff_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, staff_user_id uuid,
    property_id uuid, status text NOT NULL DEFAULT 'active'
  );
  CREATE TABLE public.tenant_assignments (id uuid PRIMARY KEY, tenant_id uuid, property_id uuid NOT NULL);

  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, public boolean NOT NULL DEFAULT false);
  CREATE TABLE storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL
  );
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  GRANT USAGE ON SCHEMA storage TO authenticated, anon;
  GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
  GRANT SELECT ON storage.objects TO anon;

  CREATE POLICY "tenant_docs_select" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'tenant-documents');
  CREATE POLICY "tenant_docs_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'tenant-documents');
  CREATE POLICY "tenant_docs_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'tenant-documents');
  CREATE POLICY "Authenticated users can view payment proofs" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'payment-proofs');
  CREATE POLICY "Authenticated users can upload payment proofs" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'payment-proofs');
  CREATE POLICY "Anyone can view property photos storage" ON storage.objects FOR SELECT USING (bucket_id = 'property-photos');
  CREATE POLICY "Authenticated users can upload property photos" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'property-photos');
  CREATE POLICY "Authenticated users can delete property photos" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'property-photos');

  INSERT INTO storage.buckets VALUES ('tenant-documents', true), ('payment-proofs', true), ('property-photos', true);
`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), OTHER_OWNER = id(2), TENANT_A = id(3), TENANT_B = id(4), STAFF = id(5), STAFF_OTHER = id(6), STRANGER = id(7);
const PROP = id(11), PROP_OTHER = id(12), ASSIGN_A = id(21), ASSIGN_B = id(22);

const FILES = {
  aDoc: ["tenant-documents", `${TENANT_A}/1700_aadhaar.jpg`],
  aDocByOwner: ["tenant-documents", `${ASSIGN_A}/1700_agreement.pdf`],
  bDoc: ["tenant-documents", `${TENANT_B}/1700_pan.jpg`],
  aProof: ["payment-proofs", `${TENANT_A}/pay1.png`],
  aUtility: ["payment-proofs", `utility/${TENANT_A}/bill1.png`],
  bProof: ["payment-proofs", `${TENANT_B}/pay2.png`],
  photo: ["property-photos", `${PROP}/1.webp`],
} as const;

let db: PGlite;

async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  await db.exec(user ? "SET ROLE authenticated" : "SET ROLE anon");
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}

async function canRead(user: string | null, [bucket, name]: readonly [string, string]) {
  return as(user, async () => {
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1 AND name = $2", [bucket, name]);
    return r.rows[0].n === 1;
  });
}

async function canInsert(user: string, bucket: string, name: string) {
  return as(user, async () => {
    try {
      await db.query("INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)", [bucket, name]);
      await db.query("DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2", [bucket, name]);
      return true;
    } catch {
      return false;
    }
  });
}

async function deletes(user: string, [bucket, name]: readonly [string, string]) {
  const r = await as(user, () => db.query("DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2", [bucket, name]));
  const gone = (r.affectedRows ?? 0) > 0;
  if (gone) await db.query("INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)", [bucket, name]);
  return gone;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(`
    INSERT INTO public.properties VALUES ('${PROP}', '${OWNER}'), ('${PROP_OTHER}', '${OTHER_OWNER}');
    INSERT INTO public.staff_members (owner_id, staff_user_id, property_id, status) VALUES
      ('${OWNER}', '${STAFF}', NULL, 'active'),
      ('${OTHER_OWNER}', '${STAFF_OTHER}', '${PROP_OTHER}', 'active');
    INSERT INTO public.tenant_assignments VALUES ('${ASSIGN_A}', '${TENANT_A}', '${PROP}'), ('${ASSIGN_B}', '${TENANT_B}', '${PROP_OTHER}');
  `);
  for (const [bucket, name] of Object.values(FILES)) {
    await db.query("INSERT INTO storage.objects (bucket_id, name) VALUES ($1, $2)", [bucket, name]);
  }
});

describe("before the fix (the live state on 2026-11-22)", () => {
  it("let a tenant read another tenant's ID proof and payment proof", async () => {
    expect(await canRead(TENANT_B, FILES.aDoc)).toBe(true);
    expect(await canRead(STRANGER, FILES.aProof)).toBe(true);
  });
});

describe("after 20261122160000_private_storage_rls", () => {
  beforeAll(async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
  });

  it("closes the public bucket links for tenant files only", async () => {
    const r = await db.query<{ id: string; public: boolean }>("SELECT id, public FROM storage.buckets ORDER BY id");
    expect(r.rows).toEqual([
      { id: "payment-proofs", public: false },
      { id: "property-photos", public: true },
      { id: "tenant-documents", public: false },
    ]);
  });

  it("tenants read their own files, never another tenant's", async () => {
    expect(await canRead(TENANT_A, FILES.aDoc)).toBe(true);
    expect(await canRead(TENANT_A, FILES.aDocByOwner)).toBe(true);
    expect(await canRead(TENANT_A, FILES.aProof)).toBe(true);
    expect(await canRead(TENANT_A, FILES.aUtility)).toBe(true);
    expect(await canRead(TENANT_B, FILES.aDoc)).toBe(false);
    expect(await canRead(TENANT_B, FILES.aProof)).toBe(false);
    expect(await canRead(TENANT_A, FILES.bDoc)).toBe(false);
  });

  it("owners and their staff read their own tenants' files only", async () => {
    for (const f of [FILES.aDoc, FILES.aDocByOwner, FILES.aProof, FILES.aUtility]) {
      expect(await canRead(OWNER, f)).toBe(true);
      expect(await canRead(STAFF, f)).toBe(true);
    }
    expect(await canRead(OWNER, FILES.bDoc)).toBe(false);
    expect(await canRead(STAFF, FILES.bProof)).toBe(false);
    expect(await canRead(OTHER_OWNER, FILES.aDoc)).toBe(false);
    expect(await canRead(STAFF_OTHER, FILES.aProof)).toBe(false);
    expect(await canRead(OTHER_OWNER, FILES.bDoc)).toBe(true);
    expect(await canRead(STAFF_OTHER, FILES.bProof)).toBe(true);
  });

  it("strangers and signed-out visitors read nothing private", async () => {
    for (const f of [FILES.aDoc, FILES.aDocByOwner, FILES.aProof, FILES.bDoc]) {
      expect(await canRead(STRANGER, f)).toBe(false);
      expect(await canRead(null, f)).toBe(false);
    }
  });

  it("uploads go only into folders the uploader may use (the app's real paths)", async () => {
    expect(await canInsert(TENANT_A, "tenant-documents", `${TENANT_A}/1800.jpg`)).toBe(true);
    expect(await canInsert(TENANT_A, "payment-proofs", `${TENANT_A}/pay9.png`)).toBe(true);
    expect(await canInsert(TENANT_A, "payment-proofs", `utility/${TENANT_A}/bill9.png`)).toBe(true);
    expect(await canInsert(OWNER, "tenant-documents", `${ASSIGN_A}/1800_rent-agreement.pdf`)).toBe(true);
    expect(await canInsert(TENANT_B, "payment-proofs", `${TENANT_A}/fake.png`)).toBe(false);
    expect(await canInsert(OTHER_OWNER, "tenant-documents", `${ASSIGN_A}/x.pdf`)).toBe(false);
    expect(await canInsert(STRANGER, "tenant-documents", "not-a-uuid/x.pdf")).toBe(false);
    expect(await canInsert(STRANGER, "tenant-documents", "loose-file.pdf")).toBe(false);
  });

  it("nobody else can delete a tenant's file", async () => {
    expect(await deletes(TENANT_B, FILES.aDoc)).toBe(false);
    expect(await deletes(STRANGER, FILES.aProof)).toBe(false);
    expect(await deletes(OTHER_OWNER, FILES.aDocByOwner)).toBe(false);
    expect(await deletes(TENANT_A, FILES.aDoc)).toBe(true);
    expect(await deletes(OWNER, FILES.aDocByOwner)).toBe(true);
  });

  it("property photos stay public to view but only their owner or staff can change them", async () => {
    expect(await canRead(null, FILES.photo)).toBe(true);
    expect(await canRead(STRANGER, FILES.photo)).toBe(true);
    expect(await canInsert(OWNER, "property-photos", `${PROP}/2.webp`)).toBe(true);
    expect(await canInsert(STAFF, "property-photos", `${PROP}/3.webp`)).toBe(true);
    expect(await canInsert(OTHER_OWNER, "property-photos", `${PROP}/4.webp`)).toBe(false);
    expect(await canInsert(TENANT_A, "property-photos", `${PROP}/5.webp`)).toBe(false);
    expect(await deletes(STRANGER, FILES.photo)).toBe(false);
    expect(await deletes(OWNER, FILES.photo)).toBe(true);
  });

  it("re-running the migration is safe", async () => {
    await db.exec(readFileSync(MIGRATION, "utf8"));
    expect(await canRead(TENANT_A, FILES.aDoc)).toBe(true);
    expect(await canRead(TENANT_B, FILES.aDoc)).toBe(false);
  });
});
