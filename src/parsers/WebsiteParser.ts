import { App, Notice, Platform, request } from 'obsidian';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import * as DOMPurify from 'isomorphic-dompurify';
import { getBaseUrl, normalizeFilename, replaceImages } from '../helpers';
import { ReadItLaterSettings } from '../settings';
import { Note } from './Note';
import { Parser } from './Parser';
import { parseHtmlContent } from './parsehtml';

type Article = {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
};

class WebsiteParser extends Parser {
    constructor(app: App, settings: ReadItLaterSettings) {
        super(app, settings);
    }

    test(url: string): boolean {
        return this.isValidUrl(url);
    }

    async prepareNote(url: string): Promise<Note> {
        const originUrl = new URL(url);
        const response = await request({ method: 'GET', url: originUrl.href });
        const document = new DOMParser().parseFromString(response, 'text/html');

        //check for existing base element
        const originBasElements = document.getElementsByTagName('base');
        let originBaseUrl = null;
        if (originBasElements.length > 0) {
            originBaseUrl = originBasElements.item(0).getAttribute('href');
            Array.from(originBasElements).forEach((originBasEl) => {
                originBasEl.remove();
            });
        }

        // Set base to allow Readability to resolve relative path's
        const baseEl = document.createElement('base');
        baseEl.setAttribute('href', getBaseUrl(originBaseUrl ?? originUrl.href, originUrl.origin));
        document.head.append(baseEl);
        const cleanDocumentBody = DOMPurify.sanitize(document.body.innerHTML);
        document.body.innerHTML = cleanDocumentBody;

        document.body.querySelectorAll('h1, h2, h3, h4, h5, h6')?.forEach(header => {
            // Readability.js will strip out headings from the dom if certain words appear in their className
            // See: https://github.com/mozilla/readability/issues/807  
            header.className = '';
            header.outerHTML = header.outerHTML;  
        });

        if (!isProbablyReaderable(document)) {
            new Notice('@mozilla/readability considers this document to unlikely be readerable.');
        }

        const previewUrl = this.extractPreviewUrl(document);
        const readableDocument = new Readability(document).parse();

        return readableDocument?.content
            ? //eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore Until Readability release fix with correct types
              this.parsableArticle(readableDocument, originUrl.href, previewUrl)
            : this.notParsableArticle(originUrl.href, previewUrl);
    }

    private async parsableArticle(article: Article, url: string, previewUrl: string | null) {
        const title = article.title || 'No title';
        const siteName = article.siteName || '';
        const author = article.byline || '';
        const content = await parseHtmlContent(article.content);

        const fileNameTemplate = this.settings.parseableArticleNoteTitle
            .replace(/%title%/g, title)
            .replace(/%date%/g, this.getFormattedDateForFilename());

        let processedContent = this.settings.parsableArticleNote
            .replace(/%date%/g, this.getFormattedDateForContent())
            .replace(/%articleTitle%/g, title)
            .replace(/%articleURL%/g, url)
            .replace(/%articleReadingTime%/g, `${this.getEstimatedReadingTime(article)}`)
            .replace(/%articleContent%/g, content)
            .replace(/%siteName%/g, siteName)
            .replace(/%author%/g, author)
            .replace(/%previewURL%/g, previewUrl || '');

        if (this.settings.downloadImages && Platform.isDesktop) {
            processedContent = await this.replaceImages(fileNameTemplate, processedContent);
        }

        const fileName = `${fileNameTemplate}.md`;
        return new Note(fileName, processedContent);
    }

    private async notParsableArticle(url: string, previewUrl: string | null) {
        console.error('Website not parseable');

        let content = this.settings.notParsableArticleNote
            .replace(/%articleURL%/g, url)
            .replace(/%previewURL%/g, previewUrl || '');

        const fileNameTemplate = this.settings.notParseableArticleNoteTitle.replace(
            /%date%/g,
            this.getFormattedDateForFilename(),
        );

        if (this.settings.downloadImages && Platform.isDesktop) {
            content = await this.replaceImages(fileNameTemplate, content);
        }

        const fileName = `${fileNameTemplate}.md`;
        return new Note(fileName, content);
    }

    /**
     * Returns estimated reading time of article in minutes
     */
    private getEstimatedReadingTime(article: Article): number {
        const lang = article.lang || 'en';
        const readingSpeed = this.getReadingSpeed(lang);
        const words = article.textContent.trim().split(/\s+/).length;

        return Math.ceil(words / readingSpeed);
    }

    /**
     * Reading speed in words per minute. Data are gathered from this study https://irisreading.com/average-reading-speed-in-various-languages/
     */
    private getReadingSpeed(lang: string): number {
        const readingSpeed = new Map([
            ['en', 228],
            ['ar', 138],
            ['de', 179],
            ['es', 218],
            ['fi', 161],
            ['fr', 195],
            ['he', 187],
            ['it', 188],
            ['ja', 193],
            ['nl', 202],
            ['pl', 166],
            ['pt', 181],
            ['ru', 184],
            ['sk', 190],
            ['sl', 180],
            ['sv', 199],
            ['tr', 166],
            ['zh', 158],
        ]);

        return readingSpeed.get(lang) || readingSpeed.get('en');
    }

    /**
     * Extracts a preview URL from the document.
     * Searches for OpenGraph `og:image` and Twitter `twitter:image` meta tags.
     * @param document The document to extract preview URL from
     */
    private extractPreviewUrl(document: Document) {
        let previewMetaElement = document.querySelector('meta[property="og:image"]');
        if (previewMetaElement == null) {
            previewMetaElement = document.querySelector('meta[name="twitter:image"]');
        }
        return previewMetaElement?.getAttribute('content');
    }

    /**
     * Replaces distant images by their locally downloaded counterparts.
     * @param noteName The note name
     * @param content The note content
     */
    private replaceImages(noteName: string, content: string) {
        const assetsDir = this.settings.downloadImagesInArticleDir
            ? `${this.settings.assetsDir}/${normalizeFilename(noteName)}/`
            : this.settings.assetsDir;
        return replaceImages(this.app, content, assetsDir);
    }
}

export default WebsiteParser;
