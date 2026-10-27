export function usePathname(): string {
  return window.location.pathname;
}

export function useRouter() {
  return {
    replace(path: string) {
      void path;
    },
  };
}
