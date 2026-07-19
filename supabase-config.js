(function () {
  const url = 'https://yuwsktbtdweirzopowhf.supabase.co';
  const key = 'sb_publishable_oi-vZmq97DcHzPet79cwqA_3pJjB3nd';
  window.db = window.supabase.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
})();
