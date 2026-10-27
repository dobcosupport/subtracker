export const supabase = {
  auth: {
    async getSession() {
      return { data: { session: { access_token: "synthetic-token" } } };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signOut() {
      return { error: null };
    },
  },
};
