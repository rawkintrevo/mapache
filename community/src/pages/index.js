import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import HomepageFeatures from '@site/src/components/HomepageFeatures';

import Heading from '@theme/Heading';
import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <p className={styles.eyebrow}>Serverless agent workspaces</p>
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/intro">
            Read the quick start
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="https://mapache.tools/">
            Open Mapache Tools
          </Link>
        </div>
      </div>
      <div className={styles.heroVisual} aria-label="Mapache workspace layout preview">
        <section className={styles.panel}>
          <span>Workspace</span>
          <strong>agent-workbench</strong>
          <code>Git linked</code>
          <code>Cloud Run ready</code>
        </section>
        <section className={clsx(styles.panel, styles.panelDark)}>
          <span>pi-coding-agent</span>
          <code>reading docs...</code>
          <code>editing session-runner/</code>
          <code className={styles.success}>verification passed</code>
        </section>
        <section className={styles.panel}>
          <span>Auth Center</span>
          <strong>Workspace scoped</strong>
          <code>ANTHROPIC_API_KEY enabled</code>
          <code>GitHub App connected</code>
        </section>
      </div>
    </header>
  );
}

export default function Home() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Community documentation for Mapache Tools serverless agent workspaces.">
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
