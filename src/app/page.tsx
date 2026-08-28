import { redirect } from "next/navigation";

// A real, verified bug without this: with cacheComponents on, a page that
// only calls redirect() and has no static fallback gets prerendered as an
// empty static shell, with the redirect deferred to a "postponed" resume
// that only a real Next.js client runtime performs. A plain HTTP client
// (curl, a crawler, JS disabled) hitting "/" got a 200 with an empty body
// instead of an actual redirect — verified by hand with curl. Forcing
// this route blocking makes redirect() run synchronously during the
// request, producing a genuine 307 response.
export const instant = false;

export default function Home() {
  redirect("/dashboard");
}
