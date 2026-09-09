import {Button} from "../../common/Button.jsx";

export function SectionEyebrow({children}) {
  return <p className="landing-eyebrow">{children}</p>;
}

export function LandingActions({action, actionLabel, href, children}) {
  return (
    <div className="landing-actions">
      <Button onClick={action}>{actionLabel}</Button>
      <a className="button button--secondary" href={href}>{children}</a>
    </div>
  );
}
