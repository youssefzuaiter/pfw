import { PageSkeleton } from "../../components/skeleton/page-skeleton";

export default function Loading() {
  return <PageSkeleton maxWidthClass="max-w-3xl" cardCount={3} />;
}
