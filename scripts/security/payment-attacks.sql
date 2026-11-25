-- Payment security check for PG Buddy: every attack from the 25 Nov 2026 audit plus the legitimate flows
-- that must keep working, run as the real database roles. It always ends in RAISE EXCEPTION, so the whole
-- transaction (test users included) is rolled back and nothing is stored or sent.
--   Run: python3 scripts/security/run-payment-attacks.py   (prints PASS/FAIL per check)
DO $audit$
DECLARE
  vo  uuid := 'a0000000-0000-4000-8000-000000000001'; -- owner of "Victim PG"
  t   uuid := 'a0000000-0000-4000-8000-000000000002'; -- tenant of Victim PG
  atk uuid := 'a0000000-0000-4000-8000-000000000003'; -- any signed-in user with no role
  o2  uuid := 'a0000000-0000-4000-8000-000000000004'; -- owner of another PG
  cl  uuid := 'a0000000-0000-4000-8000-000000000005'; -- cleaner on Victim PG staff
  mg  uuid := 'a0000000-0000-4000-8000-000000000006'; -- manager on Victim PG staff
  vp  uuid := 'b0000000-0000-4000-8000-000000000001';
  p2  uuid := 'b0000000-0000-4000-8000-000000000002';
  rm  uuid := 'c0000000-0000-4000-8000-000000000001';
  rm2 uuid := 'c0000000-0000-4000-8000-000000000002';
  pay  uuid := 'd0000000-0000-4000-8000-000000000001';
  paid uuid := 'd0000000-0000-4000-8000-000000000002';
  pend uuid := 'd0000000-0000-4000-8000-000000000003';
  ent uuid; free uuid;
  r text[] := '{}';
  n int; v text; ok boolean;
BEGIN
  INSERT INTO auth.users (id, phone, raw_user_meta_data, aud, role) VALUES
    (vo,'919990000001','{}','authenticated','authenticated'),(t,'919990000002','{}','authenticated','authenticated'),
    (atk,'919990000003','{}','authenticated','authenticated'),(o2,'919990000004','{}','authenticated','authenticated'),
    (cl,'919990000005','{}','authenticated','authenticated'),(mg,'919990000006','{}','authenticated','authenticated');
  INSERT INTO public.properties (id, owner_id, name, is_active) VALUES (vp, vo, 'Victim PG', true), (p2, o2, 'Other PG', true);
  INSERT INTO public.rooms (id, property_id, room_number) VALUES (rm, vp, '101'), (rm2, p2, '201');
  INSERT INTO public.tenant_assignments (tenant_id, property_id, room_id, is_active) VALUES (t, vp, rm, true);
  INSERT INTO public.staff_members (owner_id, staff_user_id, property_id, status, role) VALUES
    (vo, cl, vp, 'active', 'cleaner'), (vo, mg, vp, 'active', 'manager');
  INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES (vo, NULL, 'owner@okaxis');
  INSERT INTO public.rent_payments (id, tenant_id, property_id, room_id, amount, month, status) VALUES
    (pay, t, vp, rm, 8000, '2026-12', 'pending'), (paid, t, vp, rm, 8000, '2026-11', 'paid'), (pend, t, vp, rm, 8000, '2027-01', 'pending');
  SELECT id INTO ent FROM public.subscription_plans WHERE name = 'Enterprise';
  SELECT id INTO free FROM public.subscription_plans WHERE name = 'Free';
  INSERT INTO public.subscriptions (user_id, plan_id, status) VALUES (vo, free, 'active');
  INSERT INTO public.referrals (referrer_id, referral_code, referred_email, status) VALUES (vo, 'TESTCODE', 'friend@example.com', 'pending');

  ---------------- signed-in stranger
  PERFORM set_config('request.jwt.claims', json_build_object('sub', atk, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', atk::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES (atk, vp, 'fraud@ybl'); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  A1 stranger cannot set UPI for someone else''s PG');
  UPDATE public.payment_info SET upi_id = 'fraud2@ybl' WHERE owner_id = vo; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  A2 stranger cannot edit the owner''s UPI');
  SELECT count(*) INTO n FROM public.rent_payments;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  A3 stranger cannot see rent payments');
  SELECT count(*) INTO n FROM public.payment_info;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  A4 stranger cannot see bank/UPI details');
  BEGIN
    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, property_id, description)
      VALUES (atk, 'UPDATE', 'rent_payments', pay::text, vp, 'Payment approved and marked paid for 2026-12'); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  A5 stranger cannot write into an audit log');
  BEGIN
    PERFORM public.log_audit(vo, 'UPDATE', 'rent_payments', pay::text, vp, 'forged', NULL, NULL); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  A6 stranger cannot call log_audit()');
  BEGIN
    INSERT INTO public.subscriptions (user_id, plan_id, status, current_period_end) VALUES (atk, ent, 'active', '2099-01-01'); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  A7 stranger cannot give themselves a paid plan');
  EXECUTE 'RESET ROLE';

  ---------------- tenant
  PERFORM set_config('request.jwt.claims', json_build_object('sub', t, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', t::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT string_agg(upi_id, ',') INTO v FROM public.payment_info WHERE property_id = vp;
  r := array_append(r, (CASE WHEN v IS NULL THEN 'PASS' ELSE 'FAIL' END) || '  T1 tenant''s pay screen shows no planted UPI (PG-specific: ' || coalesce(v, 'none') || ')');
  SELECT string_agg(upi_id, ',') INTO v FROM public.payment_info WHERE property_id IS NULL AND owner_id = vo;
  r := array_append(r, (CASE WHEN v = 'owner@okaxis' THEN 'PASS' ELSE 'FAIL' END) || '  L1 tenant still sees the real owner''s UPI (' || coalesce(v, 'none') || ')');
  BEGIN UPDATE public.rent_payments SET status = 'paid' WHERE id = pay; ok := false; EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  T2 tenant cannot mark own rent paid');
  BEGIN UPDATE public.rent_payments SET amount = 1 WHERE id = pay; ok := false; EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  T3 tenant cannot change the amount');
  DELETE FROM public.rent_payments WHERE id = pay; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  T4 tenant cannot delete a rent record');
  BEGIN
    INSERT INTO public.rent_payments (tenant_id, property_id, room_id, amount, month, status) VALUES (t, vp, rm, 1, '2027-02', 'paid'); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  T5 tenant cannot create a paid record');
  UPDATE public.rent_payments SET proof_url = 'x/y.jpg', transaction_id = 'UTR123' WHERE id = pay; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  L2 tenant can still upload a payment proof');
  EXECUTE 'RESET ROLE';

  ---------------- another owner
  PERFORM set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', o2::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.rent_payments SET status = 'paid' WHERE id = pay; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  O1 another owner cannot change this PG''s payments');
  BEGIN
    INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES (vo, p2, 'fraud3@ybl'); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  O2 another owner cannot file UPI under this owner''s name');
  BEGIN
    INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES (o2, vp, 'fraud4@ybl'); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  O3 another owner cannot set UPI for this PG');
  EXECUTE 'RESET ROLE';

  ---------------- staff
  PERFORM set_config('request.jwt.claims', json_build_object('sub', cl, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', cl::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.payment_info;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  S1 cleaner cannot see the owner''s bank/UPI details');
  UPDATE public.rent_payments SET status = 'paid' WHERE id = pay; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  S2 cleaner cannot mark rent paid');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', mg, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', mg::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.payment_info;
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  L3 manager can still see the owner''s details');
  UPDATE public.payment_info SET upi_id = 'manager@ybl' WHERE owner_id = vo; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  S3 manager cannot change where rent money goes');
  EXECUTE 'RESET ROLE';

  ---------------- the owner
  PERFORM set_config('request.jwt.claims', json_build_object('sub', vo, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', vo::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    UPDATE public.subscriptions SET plan_id = ent, current_period_end = '2099-01-01' WHERE user_id = vo; GET DIAGNOSTICS n = ROW_COUNT;
    ok := n = 0;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  V1 owner cannot upgrade their own plan without paying');
  SELECT count(*) INTO n FROM public.subscriptions WHERE user_id = vo;
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  L4 owner can still see their subscription');
  BEGIN DELETE FROM public.rent_payments WHERE id = paid; ok := false; EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  V2 a paid rent record cannot be deleted');
  DELETE FROM public.rent_payments WHERE id = pend; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  L5 owner can still delete a pending record');
  UPDATE public.rent_payments SET status = 'paid', approved_by = vo WHERE id = pay; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  L6 owner can still approve a payment');
  UPDATE public.payment_info SET upi_id = 'newupi@okaxis' WHERE owner_id = vo AND property_id IS NULL; GET DIAGNOSTICS n = ROW_COUNT;
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  L7 owner can still change their own UPI');
  BEGIN
    INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES (vo, vp, 'pgspecific@okaxis'); ok := true;
  EXCEPTION WHEN others THEN ok := false; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  L8 owner can still set PG-specific details for their own PG');
  EXECUTE 'RESET ROLE';
  SELECT count(*) INTO n FROM public.audit_logs WHERE record_id = pend::text AND action = 'DELETE';
  r := array_append(r, (CASE WHEN n = 1 THEN 'PASS' ELSE 'FAIL' END) || '  V3 the deletion is in the audit log');
  SELECT count(*) INTO n FROM public.audit_logs WHERE table_name = 'payment_info' AND action = 'UPDATE';
  r := array_append(r, (CASE WHEN n >= 1 THEN 'PASS' ELSE 'FAIL' END) || '  V4 the UPI change is in the audit log');
  SELECT count(*) INTO n FROM public.notifications WHERE user_id = vo AND title LIKE 'Payment details%';
  r := array_append(r, (CASE WHEN n >= 1 THEN 'PASS' ELSE 'FAIL' END) || '  V5 the owner is notified of the UPI change (' || n || ' alerts)');

  ---------------- signed out
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO n FROM public.rent_payments;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  N1 signed-out caller cannot see rent payments');
  SELECT count(*) INTO n FROM public.payment_info;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  N2 signed-out caller cannot see bank/UPI details');
  SELECT count(*) INTO n FROM public.referrals;
  r := array_append(r, (CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END) || '  N3 signed-out caller cannot list referrals / e-mails');
  BEGIN
    PERFORM public.log_audit(vo, 'UPDATE', 'rent_payments', pay::text, vp, 'forged', NULL, NULL); ok := false;
  EXCEPTION WHEN others THEN ok := true; END;
  r := array_append(r, (CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END) || '  N4 signed-out caller cannot call log_audit()');
  EXECUTE 'RESET ROLE';

  RAISE EXCEPTION 'AUDIT_RESULTS%', E'\n' || array_to_string(r, E'\n');
END
$audit$;
