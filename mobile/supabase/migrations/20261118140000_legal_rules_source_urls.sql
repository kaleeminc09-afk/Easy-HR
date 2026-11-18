-- Legal rules: store the verified official source URL for the Ontario
-- minimum-wage rows, so the Brain quotes a real link instead of inventing
-- one. URL verified 2026-11-18 against Ontario's Employment Standards Act
-- guide (rates $17.95 / $16.90 / $19.70 effective Oct 1, 2026).
-- Break-rule rows keep source_url NULL until their official pages are
-- verified the same way; the Brain names the site without a link when
-- no URL is stored.

update public.legal_rules
set source_url = 'https://www.ontario.ca/document/your-guide-employment-standards-act-0/minimum-wage'
where rule_key in (
  'ON.min_wage_general',
  'ON.min_wage_student',
  'ON.min_wage_homeworker'
);
