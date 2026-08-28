import { Badge } from "../../components/badge/badge";
import { TiltCard } from "../../components/tilt/tilt-card";
import { getCurrentUser } from "../../server/auth/current-user";
import { listAllCategories } from "../../server/dal/categories";
import { CategoryRowActions } from "./_components/category-row-actions";
import { CreateCategoryForm } from "./_components/create-category-form";

export const instant = false;

export default async function CategoriesPage() {
  const user = await getCurrentUser();
  const categories = await listAllCategories(user.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <h1 className="font-display text-2xl font-semibold text-fg">Categories</h1>
      <section className="rounded-lg border border-border bg-surface p-4">
        <CreateCategoryForm />
      </section>
      {/*
        Category cards carry no financial figures (name/slug/actions
        only), so a 3D tilt on hover is safe here per Section 5's "never
        apply tilt to cards containing active figures being read" — these
        are the "category cards" the tilt rule names explicitly.
      */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {categories.map((category) => (
          <li key={category.id}>
            <TiltCard className="flex h-full flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4">
              <div>
                <p className="flex items-center gap-2 font-medium text-fg">
                  {category.name}
                  {category.archivedAt && <Badge variant="neutral">Archived</Badge>}
                </p>
                <p className="text-xs text-muted">slug: {category.slug}</p>
              </div>
              <CategoryRowActions
                category={{
                  id: category.id,
                  name: category.name,
                  isUncategorized: category.isUncategorized,
                  archivedAt: category.archivedAt,
                }}
              />
            </TiltCard>
          </li>
        ))}
      </ul>
    </div>
  );
}
