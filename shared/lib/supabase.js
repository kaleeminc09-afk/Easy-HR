import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://ejnkgsddglyabzsivcuu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SjRR02ZzLj3Nf1WX15lnGA_HD7mvEJz';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);