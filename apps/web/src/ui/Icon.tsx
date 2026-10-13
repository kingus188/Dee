export function Icon({ name }: { name: string }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href={`/assets/icons.svg#${name}`} /></svg>;
}
