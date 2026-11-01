import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { markdownExtensions } from '@simple-mark/model';
import { describe, expect, it } from 'vitest';
import { blockPreviewSources, imageResolver, type ImageResolver } from '../src/previews';

function sources(doc: string, resolve?: ImageResolver) {
  let state = EditorState.create({
    doc,
    extensions: [markdown({ base: commonmarkLanguage, extensions: markdownExtensions }), resolve ? imageResolver.of(resolve) : []],
  });
  // A new state parses for 20 ms at most, and the first test of a cold run can take longer
  // (the reference definition was then missing). Finish the parse, then take its tree.
  ensureSyntaxTree(state, state.doc.length, 5000);
  state = state.update({}).state;
  // Report each preview by the text of the line it follows.
  return blockPreviewSources(state).map((p) => ({ ...p, at: state.doc.lineAt(p.at).text }));
}

describe('image previews', () => {
  it('previews inline and reference images below their line, one widget per line', () => {
    expect(sources('![a](x.png) and ![b][logo]\n\n[logo]: <logo.svg>')).toEqual([
      {
        at: '![a](x.png) and ![b][logo]',
        images: [
          { raw: 'x.png', src: 'x.png', alt: 'a' },
          { raw: 'logo.svg', src: 'logo.svg', alt: 'b' },
        ],
      },
    ]);
  });

  it('resolves collapsed and shortcut references case-insensitively', () => {
    const images = (doc: string) => sources(doc).flatMap((p) => ('images' in p ? p.images.map((i) => i.raw) : []));
    expect(images('![Logo][]\n\n[logo]: a.png')).toEqual(['a.png']);
    expect(images('![The  Logo]\n\n[the logo]: b.png')).toEqual(['b.png']);
  });

  it('reports a missing definition', () => {
    expect(sources('![x][nope]')[0]).toMatchObject({ images: [{ src: null, problem: 'No definition for [nope]' }] });
  });

  it('asks the host to resolve paths', () => {
    const resolve = (src: string) => (src.startsWith('http') ? null : `vscode-resource:/docs/${src}`);
    expect(sources('![a](img/a.png) ![b](https://x.y/b.png)', resolve)[0]).toMatchObject({
      images: [{ src: 'vscode-resource:/docs/img/a.png' }, { src: null, problem: "Can't load https://x.y/b.png" }],
    });
  });
  it('shows an image as loading while the host is still loading its file', () => {
    const resolve = (src: string) => (src === 'later.png' ? undefined : null);
    expect(sources('![a](later.png) ![b](gone.png)', resolve)[0]).toMatchObject({
      images: [
        { src: null, loading: true, problem: 'Loading later.png…' },
        { src: null, problem: "Can't load gone.png" },
      ],
    });
  });

  it('keeps further places to try when the host gives several', () => {
    const resolve = (src: string) => (src.startsWith('/') ? [`disk:${src}`, `workspace:${src}`] : src);
    expect(sources('![a](/img/a.png) ![b](b.png)', resolve)[0]).toMatchObject({
      images: [
        { src: 'disk:/img/a.png', fallbacks: ['workspace:/img/a.png'] },
        { src: 'b.png', alt: 'b' },
      ],
    });
  });
});



describe('math previews', () => {
  it('previews closed $$ blocks below their closing line', () => {
    expect(sources('$$\na\nb\n$$\n\n$$ c $$')).toEqual([
      { at: '$$', tex: 'a\nb' },
      { at: '$$ c $$', tex: ' c ' },
    ]);
  });

  it('skips open and empty blocks', () => {
    expect(sources('$$\n$$\n\n$$\nx')).toEqual([]);
  });

  it('leaves quote markers out of the TeX', () => {
    expect(sources('> $$\n> x\n> $$')).toEqual([{ at: '> $$', tex: 'x' }]);
  });
});
