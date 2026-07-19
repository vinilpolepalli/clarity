import logoUrl from "../build/icon-1024.png";

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <img className="brand-mark__image" src={logoUrl} alt="" />
    </span>
  );
}
