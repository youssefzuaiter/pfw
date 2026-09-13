import { PageSkeleton } from "../../../components/skeleton/page-skeleton";

export default function Loading() {
  return <PageSkeleton maxWidthClass="max-w-4xl" cardCount={2} />;
}
