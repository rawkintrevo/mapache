import {Button} from "../common/Button.jsx";

function StoryWords({text}) {
  let letterIndex = 0;

  return text.split(" ").map((word, wordIndex) => (
    <span aria-hidden="true" className="story-word" key={`${word}-${wordIndex}`}>
      {Array.from(word).map((letter, letterOffset) => {
        const currentIndex = letterIndex;
        letterIndex += 1;
        return (
          <span
            className="story-letter"
            key={`${wordIndex}-${letterOffset}`}
            style={{"--letter-delay": `${currentIndex * 45}ms`}}
          >
            {letter}
          </span>
        );
      })}
    </span>
  ));
}

export function AuthScreen({onSignIn}) {
  const storyText = "Once, I got so angry at Anthropic for ruining all the open souce foundations...";
  const followupText = "that I made Mapache Tools using only rage and spite.";
  const closingText = "I hope you enjoy it.";

  return (
    <div className="auth">
      <aside aria-label={storyText} className="auth-story" style={{"--story-delay": "700ms"}}>
        <StoryWords text={storyText} />
      </aside>
      <aside
        aria-label={followupText}
        className="auth-story auth-story-followup"
        style={{"--story-delay": "6200ms"}}
      >
        <StoryWords text={followupText} />
      </aside>
      <section className="auth-panel" style={{"--story-delay": "10400ms"}}>
        <p aria-label={closingText} className="auth-panel-message">
          <StoryWords text={closingText} />
        </p>
        <Button onClick={onSignIn}>Sign in with Google</Button>
      </section>
    </div>
  );
}
