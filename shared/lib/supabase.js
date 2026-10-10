import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ejnkgsddglyabzsivcuu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_RKZg5K10ckrn_icSUUM7KQ_MM71egkI';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);