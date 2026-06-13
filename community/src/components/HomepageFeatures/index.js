import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

const FeatureList = [
  {
    eyebrow: 'Workspace docs',
    title: 'Launch isolated agent sessions',
    description: (
      <>
        Connect a repository, choose a runtime image, and start a Cloud Run backed
        workspace without rebuilding your local machine around each agent.
      </>
    ),
  },
  {
    eyebrow: 'Runtime notes',
    title: 'Understand the container boundary',
    description: (
      <>
        The docs explain runner image choices, workspace file sync, terminal
        behavior, and the operational assumptions behind serverless sessions.
      </>
    ),
  },
  {
    eyebrow: 'Auth center',
    title: 'Keep credentials workspace scoped',
    description: (
      <>
        Store provider credentials in your profile, then enable only the secrets
        each workspace needs through predictable generated files and variables.
      </>
    ),
  },
];

function Feature({eyebrow, title, description}) {
  return (
    <div className={clsx('col col--4', styles.featureColumn)}>
      <article className={styles.featureCard}>
        <span>{eyebrow}</span>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </article>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
