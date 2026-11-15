import { BrandLogo } from "@/components/ui/brand-logo";
import { GoBackLink, HomeLink } from "@/components/ui/not-found-actions";

export const metadata = { title: "SMS | Page not found" };

export default function NotFound() {
  return (
    <div className="not-found-page">
      <div className="not-found-frame">
        <header className="login-brand not-found-brand">
          <BrandLogo size={40} />
          <div><p className="login-brand-name">SMS</p><p className="login-brand-caption">School Management System</p></div>
        </header>

        <main className="not-found-main">
          <p className="not-found-code" aria-hidden="true">404</p>
          <h1 className="not-found-title">We can’t find that page</h1>
          <p className="not-found-text">The link may be broken, or the page may have moved.</p>
          <div className="not-found-actions">
            <HomeLink className="login-submit" />
            <GoBackLink className="login-google" />
          </div>
        </main>

        <footer className="not-found-footer">Need help? Contact your school office.</footer>
      </div>
    </div>
  );
}
