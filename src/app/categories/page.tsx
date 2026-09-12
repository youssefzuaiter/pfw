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
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
      <h1 className="font-display text-xl font-semibold text-slate-100">Categories</h1>
      <section className="rounded-lg border border-slate-800/80 bg-slate-900 p-4">
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
            <TiltCard className="flex h-full flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-slate-900 p-4">
              <div>
                <p className="flex items-center gap-2 font-medium text-slate-100">
                  {category.name}
                  {category.archivedAt && <Badge variant="neutral">Archived</Badge>}
                </p>
                <p className="text-xs text-slate-400">slug: {category.slug}</p>
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
