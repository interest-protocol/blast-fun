export const usePathname = () => "/verification";
export const useSearchParams = () => new URLSearchParams(location.search);
export const useRouter = () => ({ push: (path: string) => { document.body.dataset.destination = path; }, replace() {}, prefetch() {} });
export const useParams = () => ({});
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export function notFound(): never { throw new Error("Fixture not found"); }
export function redirect(): never { throw new Error("Unexpected fixture redirect"); }
