import { render } from 'preact';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App';

render(<App />, document.getElementById('app')!);
