import { BRAND_PAGE_URLS } from "../brand-pages/routes";

// Top-right brand entry; opens the Calileon+ page in a new tab so the current
// board stays open.
export const ExcalidrawPlusPromoBanner = () => {
  return (
    <a
      href={BRAND_PAGE_URLS.plus}
      target="_blank"
      rel="noopener"
      className="plus-banner"
    >
      Calileon+
    </a>
  );
};
