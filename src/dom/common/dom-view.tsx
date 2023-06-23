import {
	Annotation,
	AnnotationPopupParams,
	AnnotationType,
	ArrayRect,
	WADMAnnotation,
	FindState,
	NewAnnotation,
	OutlineItem,
	OverlayPopupParams,
	SelectionPopupParams,
	Tool,
	ViewStats,
	NavLocation,
	MaybePromise,
} from "../../common/types";
import PopupDelayer from "../../common/lib/popup-delayer";
import ReactDOM from "react-dom";
import {
	AnnotationOverlay,
	DisplayedAnnotation
} from "./components/overlay/annotation-overlay";
import React from "react";
import { Selector } from "./lib/selector";
import {
	caretPositionFromPoint,
	makeRangeSpanning,
	moveRangeEndsIntoTextNodes,
	supportsCaretPositionFromPoint
} from "./lib/range";
import { getSelectionRanges } from "./lib/selection";
import { FindProcessor } from "./find";
import { SELECTION_COLOR } from "../../common/defines";
import { isSafari } from "../../common/lib/utilities";
import {
	isElement
} from "./lib/nodes";

abstract class DOMView<State extends DOMViewState> {
	initializedPromise: Promise<void>;

	protected readonly _container: Element;

	protected readonly _iframe: HTMLIFrameElement;

	protected _iframeWindow!: Window & typeof globalThis;

	protected _iframeDocument!: Document;

	protected _tool!: Tool;

	protected _selectedAnnotationIDs: string[];

	protected _annotations!: WADMAnnotation[];

	protected _annotationsByID!: Map<string, WADMAnnotation>;

	protected _showAnnotations: boolean;

	protected _annotationPopup: AnnotationPopupParams<WADMAnnotation> | null;

	protected _selectionPopup: SelectionPopupParams<WADMAnnotation> | null;

	protected _overlayPopup: OverlayPopupParams | null;

	protected _findState: FindState | null;

	protected abstract _find: FindProcessor | null;

	protected _viewState: Partial<State>;

	protected readonly _options: DOMViewOptions<State>;

	protected _overlayPopupDelayer: PopupDelayer;

	protected _disableAnnotationPointerEvents = false;

	protected _highlightedPosition: Selector | null = null;

	protected _gotPointerUp = false;

	protected _previewAnnotation: NewAnnotation<WADMAnnotation> | null = null;

	protected _draggingNoteAnnotation: WADMAnnotation | null = null;

	protected _resizing = false;

	protected constructor(options: DOMViewOptions<State>) {
		this._options = options;
		this._container = options.container;

		this._selectedAnnotationIDs = options.selectedAnnotationIDs;
		// Don't show annotations if this is false
		this._showAnnotations = options.showAnnotations;
		this._annotationPopup = options.annotationPopup;
		this._selectionPopup = options.selectionPopup;
		this._overlayPopup = options.overlayPopup;
		this._findState = options.findState;
		this._viewState = options.viewState || {};
		this._overlayPopupDelayer = new PopupDelayer({ open: !!this._overlayPopup });

		this._iframe = document.createElement('iframe');
		this._iframe.sandbox.add('allow-same-origin');
		// A WebKit bug prevents listeners added by the parent page (us) from running inside a child frame (this._iframe)
		// unless the allow-scripts permission is added to the frame's sandbox. That means that we have to allow scripts
		// and very carefully sanitize.
		// https://bugs.webkit.org/show_bug.cgi?id=218086
		if (isSafari) {
			this._iframe.sandbox.add('allow-scripts');
		}
		this._iframe.srcdoc = this._getSrcDoc();
		this.initializedPromise = new Promise((resolve, reject) => {
			this._iframe.addEventListener(
				'load',
				() => this._handleIFrameLoad().then(resolve, reject),
				{ once: true });
		});
		options.container.append(this._iframe);
	}

	protected abstract _getSrcDoc(): string;

	protected abstract _onInitialDisplay(viewState: Partial<State>): MaybePromise<void>;

	// ***
	// Utilities for annotations - abstractions over the specific types of selectors used by the two views
	// ***

	abstract toSelector(range: Range): Selector | null;

	abstract toDisplayedRange(selector: Selector): Range | null;

	protected abstract _navigateToSelector(selector: Selector, options?: NavigateOptions): void;

	// ***
	// Abstractions over document structure
	// ***

	protected abstract _getAnnotationOverlayParent(): ParentNode | null;

	protected abstract _getAnnotationFromRange(range: Range, type: AnnotationType, color?: string): NewAnnotation<WADMAnnotation> | null;

	protected abstract _updateViewState(): void;

	protected abstract _updateViewStats(): void;

	protected abstract _isExternalLink(link: HTMLAnchorElement): boolean;

	// ***
	// Utilities - called in appropriate event handlers
	// ***

	protected _getViewportBoundingRect(range: Range): DOMRect {
		let rect = range.getBoundingClientRect();
		return new DOMRect(
			rect.x + this._iframe.getBoundingClientRect().x - this._container.getBoundingClientRect().x,
			rect.y + this._iframe.getBoundingClientRect().y - this._container.getBoundingClientRect().y,
			rect.width,
			rect.height
		);
	}

	protected _getAnnotationFromTextSelection(type: AnnotationType, color?: string): NewAnnotation<WADMAnnotation> | null {
		let selection = this._iframeDocument.getSelection();
		if (!selection || selection.isCollapsed) {
			return null;
		}
		let range = makeRangeSpanning(...getSelectionRanges(selection));
		return this._getAnnotationFromRange(range, type, color);
	}

	protected _tryUseTool() {
		this._updateViewStats();

		if (this._tool.type == 'pointer') {
			if (this._gotPointerUp) {
				let selection = this._iframeWindow.getSelection();
				if (selection && !selection.isCollapsed) {
					this._openSelectionPopup(selection);
				}
			}
			return;
		}

		if (this._tool.type == 'highlight' || this._tool.type == 'underline') {
			if (this._gotPointerUp) {
				let annotation = this._getAnnotationFromTextSelection(this._tool.type, this._tool.color);
				if (annotation && annotation.text) {
					this._options.onAddAnnotation(annotation);
				}
				this._iframeWindow.getSelection()?.removeAllRanges();
				this._previewAnnotation = null;
			}
			else {
				this._previewAnnotation = this._getAnnotationFromTextSelection(this._tool.type, this._tool.color);
			}
			this._renderAnnotations();
		}
	}

	protected _handleViewUpdate() {
		this._updateViewState();
		this._updateViewStats();
		this._renderAnnotations();
		this._repositionPopups();
	}

	protected _repositionPopups() {
		// Update annotation popup position
		if (this._annotationPopup) {
			let { annotation } = this._annotationPopup;
			if (annotation) {
				// Note: There is currently a bug in React components part therefore the popup doesn't
				// properly update its position when window is resized
				this._openAnnotationPopup(annotation as WADMAnnotation);
			}
		}

		// Update selection popup position
		if (this._selectionPopup) {
			let selection = this._iframeWindow.getSelection();
			if (selection) {
				this._openSelectionPopup(selection);
			}
		}

		// Close overlay popup
		this._options.onSetOverlayPopup();
	}

	protected _renderAnnotations() {
		let root = this._getAnnotationOverlayParent();
		if (!root) {
			return;
		}
		let doc = root.ownerDocument!;
		let container = root.querySelector('#annotation-overlay');
		if (!this._showAnnotations) {
			if (container) {
				container.remove();
			}
			return;
		}
		if (!container) {
			container = doc.createElement('div');
			container.id = 'annotation-overlay';
			root.append(container);
		}
		let displayedAnnotations: DisplayedAnnotation[] = [
			...this._annotations.map(a => ({
				id: a.id,
				type: a.type,
				color: a.color,
				sortIndex: a.sortIndex,
				text: a.text,
				comment: a.comment,
				key: a.id,
				range: this.toDisplayedRange(a.position),
			})).filter(a => !!a.range) as DisplayedAnnotation[],
			...this._find?.getAnnotations() ?? []
		];
		if (this._highlightedPosition) {
			displayedAnnotations.push({
				type: 'highlight',
				color: SELECTION_COLOR,
				key: '_highlightedPosition',
				range: this.toDisplayedRange(this._highlightedPosition)!,
			});
		}
		if (this._previewAnnotation
			// Don't show preview if dragged note annotation hasn't moved
			&& !(this._draggingNoteAnnotation
				&& this._previewAnnotation.sortIndex == this._draggingNoteAnnotation.sortIndex)) {
			displayedAnnotations.push({
				type: this._previewAnnotation.type,
				color: this._previewAnnotation.color,
				sortIndex: this._previewAnnotation.sortIndex,
				text: this._previewAnnotation.text,
				comment: this._previewAnnotation.comment,
				key: '_previewAnnotation',
				range: this.toDisplayedRange(this._previewAnnotation.position)!,
			});
		}
		ReactDOM.render((
			<AnnotationOverlay
				iframe={this._iframe}
				annotations={displayedAnnotations}
				selectedAnnotationIDs={this._selectedAnnotationIDs}
				onPointerDown={this._handleAnnotationPointerDown}
				onDragStart={this._handleAnnotationDragStart}
				onResizeStart={this._handleAnnotationResizeStart}
				onResizeEnd={this._handleAnnotationResizeEnd}
				disablePointerEvents={this._disableAnnotationPointerEvents}
			/>
		), container);
	}

	protected _openSelectionPopup(selection: Selection) {
		if (selection.isCollapsed) {
			return;
		}
		let range = moveRangeEndsIntoTextNodes(makeRangeSpanning(...getSelectionRanges(selection)));
		let domRect = this._getViewportBoundingRect(range);
		let rect: ArrayRect = [domRect.left, domRect.top, domRect.right, domRect.bottom];
		let annotation = this._getAnnotationFromRange(range, 'highlight');
		if (annotation) {
			this._options.onSetSelectionPopup({ rect, annotation });
		}
	}

	protected _openAnnotationPopup(annotation: WADMAnnotation) {
		// Note: Popup won't be visible if sidebar is opened
		let domRect;
		if (annotation.type == 'note') {
			domRect = this._iframeDocument.querySelector(`[data-annotation-id="${annotation.id}"]`)
				?.getBoundingClientRect();
		}
		if (!domRect) {
			let range = this.toDisplayedRange(annotation.position);
			if (!range) {
				return;
			}
			domRect = this._getViewportBoundingRect(range);
		}
		let rect: ArrayRect = [domRect.left, domRect.top, domRect.right, domRect.bottom];
		this._options.onSetAnnotationPopup({ rect, annotation });
	}

	protected _openExternalLinkOverlayPopup(linkNode: HTMLAnchorElement) {
		let range = linkNode.ownerDocument.createRange();
		range.selectNode(linkNode);
		let domRect = range.getBoundingClientRect();
		let rect: ArrayRect = [domRect.left, domRect.top, domRect.right, domRect.bottom];
		let overlayPopup = {
			type: 'external-link',
			url: linkNode.href,
			rect,
			ref: linkNode
		};
		this._options.onSetOverlayPopup(overlayPopup);
	}

	/**
	 * For use in the console during development.
	 */
	protected _normalizeAnnotations() {
		this._options.onUpdateAnnotations(this._annotations.map((annotation) => {
			let range = this.toDisplayedRange(annotation.position);
			if (!range) {
				console.warn('Could not create range for annotation', annotation);
				return annotation;
			}
			range = moveRangeEndsIntoTextNodes(range);
			let newAnnotation = this._getAnnotationFromRange(range, annotation.type, annotation.color);
			if (!newAnnotation) {
				console.warn('Could not create annotation from normalized range', annotation);
				return annotation;
			}
			return {
				...annotation,
				...newAnnotation,
			};
		}));
	}

	// ***
	// Event handlers
	// ***

	protected async _handleIFrameLoad() {
		this._iframeWindow = this._iframe.contentWindow as Window & typeof globalThis;
		this._iframeDocument = this._iframe.contentDocument!;

		this._iframeWindow.addEventListener('contextmenu', this._handleContextMenu.bind(this));
		this._iframeWindow.addEventListener('keyup', this._options.onKeyUp);
		this._iframeWindow.addEventListener('keydown', this._handleKeyDown.bind(this), true);
		this._iframeWindow.addEventListener('click', this._handleClick.bind(this));
		this._iframeWindow.addEventListener('pointerover', this._handlePointerOver.bind(this));
		this._iframeWindow.addEventListener('pointerdown', this._handlePointerDown.bind(this), true);
		this._iframeWindow.addEventListener('pointerup', this._handlePointerUp.bind(this));
		this._iframeWindow.addEventListener('dragstart', this._handleDragStart.bind(this), { capture: true });
		this._iframeWindow.addEventListener('dragenter', this._handleDragEnter.bind(this));
		this._iframeWindow.addEventListener('dragover', this._handleDragOver.bind(this));
		this._iframeWindow.addEventListener('dragend', this._handleDragEnd.bind(this));
		this._iframeWindow.addEventListener('drop', this._handleDrop.bind(this));
		// @ts-ignore
		this._iframeWindow.addEventListener('copy', this._handleCopy.bind(this));
		this._iframeWindow.addEventListener('resize', this._handleResize.bind(this));
		this._iframeWindow.addEventListener('focus', this._handleFocus.bind(this));
		this._iframeDocument.addEventListener('scroll', this._handleScroll.bind(this), { passive: true });
		this._iframeDocument.addEventListener('selectionchange', this._handleSelectionChange.bind(this));

		// Pass options to setters that were delayed until iframe initialization
		this.setAnnotations(this._options.annotations);
		this.setTool(this._options.tool);

		await this._onInitialDisplay(this._options.viewState || {});
		setTimeout(() => {
			this._handleViewUpdate();
		});
	}

	protected _handlePointerOver(event: PointerEvent) {
		let target = event.target as Element;
		const link = target.closest('a');
		if (link && this._isExternalLink(link)) {
			this._overlayPopupDelayer.open(link, () => {
				this._openExternalLinkOverlayPopup(link);
			});
		}
		else {
			this._overlayPopupDelayer.close(() => {
				this._options.onSetOverlayPopup();
			});
		}

		if (this._tool.type == 'note') {
			let range = this._getNoteTargetRange(event);
			this._previewAnnotation = this._getAnnotationFromRange(range, 'note', this._tool.color);
			this._renderAnnotations();
		}
	}

	protected _handleDragEnter(event: DragEvent) {
		if (!this._draggingNoteAnnotation) {
			return;
		}
		event.preventDefault();
		let range = this._getNoteTargetRange(event);
		this._previewAnnotation = this._getAnnotationFromRange(range, 'note', this._draggingNoteAnnotation.color);
		this._renderAnnotations();
	}

	protected _handleDragOver(event: DragEvent) {
		if (!this._draggingNoteAnnotation || !this._previewAnnotation) {
			return;
		}
		event.preventDefault();
	}

	protected _handleDrop() {
		if (!this._draggingNoteAnnotation || !this._previewAnnotation) {
			return;
		}
		this._draggingNoteAnnotation.position = this._previewAnnotation.position;
		this._draggingNoteAnnotation.pageLabel = this._previewAnnotation.pageLabel;
		this._draggingNoteAnnotation.sortIndex = this._previewAnnotation.sortIndex;
		this._draggingNoteAnnotation.text = this._previewAnnotation.text;
		this._options.onUpdateAnnotations([this._draggingNoteAnnotation]);
	}

	protected _getNoteTargetRange(event: PointerEvent | DragEvent) {
		let target = event.target as Element;
		// Disable pointer events and rerender so we can get the cursor position in the text layer,
		// not the annotation layer, even if the mouse is over the annotation layer
		let range = this._iframeDocument.createRange();
		if (target.tagName === 'IMG') { // Allow targeting images directly
			range.selectNode(target);
		}
		else if (target.closest('[data-annotation-id]')) {
			let annotation = this._annotationsByID.get(
				target.closest('[data-annotation-id]')!.getAttribute('data-annotation-id')!
			)!;
			let annotationRange = this.toDisplayedRange(annotation.position)!;
			range.setStart(annotationRange.startContainer, annotationRange.startOffset);
			range.setEnd(annotationRange.endContainer, annotationRange.endOffset);
		}
		else {
			let pos = supportsCaretPositionFromPoint()
				&& caretPositionFromPoint(this._iframeDocument, event.clientX, event.clientY);
			let node = pos ? pos.offsetNode : target;
			// Expand to the closest block element
			while (node.parentNode
					&& (!isElement(node) || this._iframeWindow.getComputedStyle(node).display.includes('inline'))) {
				node = node.parentNode;
			}
			range.selectNode(node);
		}
		return range;
	}

	protected _handleClick(event: MouseEvent) {
		let link = (event.target as Element).closest('a');
		if (!link) {
			return;
		}
		event.preventDefault();
		if (this._isExternalLink(link)) {
			this._options.onOpenLink(link.href);
		}
		else {
			this._handleInternalLinkClick(link);
		}
	}

	protected abstract _handleInternalLinkClick(link: HTMLAnchorElement): void;

	protected _handleKeyDown(event: KeyboardEvent) {
		let { key } = event;
		let shift = event.shiftKey;

		// Focusable elements in PDF view are annotations and overlays (links, citations, figures).
		// Once TAB is pressed, arrows can be used to navigate between them
		let focusableElements: HTMLElement[] = [];
		let focusedElementIndex = -1;
		let focusedElement: HTMLElement | null = this._iframeDocument.activeElement as HTMLElement | null;
		for (let element of this._iframeDocument.querySelectorAll('[tabindex="-1"]')) {
			focusableElements.push(element as HTMLElement);
			if (element === focusedElement) {
				focusedElementIndex = focusableElements.length - 1;
			}
		}

		if (key === 'Escape' && !this._resizing) {
			if (this._selectedAnnotationIDs.length) {
				this._options.onSelectAnnotations([], event);
			}
			else if (focusedElement) {
				focusedElement.blur();
			}
			this._iframeWindow.getSelection()?.removeAllRanges();
			// The keyboard shortcut was handled here, therefore no need to
			// pass it to this._onKeyDown(event) below
			return;
		}
		else if (shift && key === 'Tab') {
			if (focusedElement) {
				focusedElement.blur();
			}
			else {
				this._options.onTabOut(true);
			}
			event.preventDefault();
			return;
		}
		else if (key === 'Tab') {
			if (!focusedElement) {
				// In PDF view the first visible object (annotation, overlay) is focused
				if (focusableElements.length) {
					focusableElements[0].focus();
				}
				else {
					this._options.onTabOut();
				}
			}
			else {
				this._options.onTabOut();
			}
			event.preventDefault();
			return;
		}

		if (focusedElement) {
			if (!window.rtl && key === 'ArrowRight' || window.rtl && key === 'ArrowLeft' || key === 'ArrowDown') {
				focusableElements[focusedElementIndex + 1]?.focus();
				event.preventDefault();
				return;
			}
			else if (!window.rtl && key === 'ArrowLeft' || window.rtl && key === 'ArrowRight' || key === 'ArrowUp') {
				focusableElements[focusedElementIndex - 1]?.focus();
				event.preventDefault();
				return;
			}
			else if (['Enter', 'Space'].includes(key)) {
				if (focusedElement.classList.contains('highlight')) {
					let annotationID = focusedElement.getAttribute('data-annotation-id')!;
					let annotation = this._annotationsByID.get(annotationID);
					if (annotation) {
						this._options.onSelectAnnotations([annotationID], event);
						if (this._selectedAnnotationIDs.length == 1) {
							this._openAnnotationPopup(annotation);
						}
						return;
					}
				}
			}
		}

		// Pass keydown even to the main window where common keyboard
		// shortcuts are handled i.e. Delete, Cmd-Minus, Cmd-f, etc.
		this._options.onKeyDown(event);
	}

	private _handleDragStart(event: DragEvent) {
		this._previewAnnotation = null;
		if (!event.dataTransfer) {
			return;
		}
		let annotation = this._getAnnotationFromTextSelection('highlight');
		if (!annotation) {
			return;
		}
		console.log('Dragging text', annotation);
		this._options.onSetDataTransferAnnotations(event.dataTransfer, annotation, true);
	}

	private _handleDragEnd(_event: DragEvent) {
		this._draggingNoteAnnotation = null;
		this._previewAnnotation = null;
		this._renderAnnotations();
	}

	private _handleContextMenu(event: MouseEvent) {
		// Prevent native context menu
		event.preventDefault();
		let br = this._iframe.getBoundingClientRect();
		this._options.onOpenViewContextMenu({ x: br.x + event.clientX, y: br.y + event.clientY });
	}

	private _handleSelectionChange() {
		let selection = this._iframeDocument.getSelection();
		if (!selection || selection.isCollapsed) {
			this._options.onSetSelectionPopup(null);
		}
		else {
			this._updateViewStats();
			this._tryUseTool();
		}
	}

	private _handleAnnotationPointerDown = (id: string, event: React.PointerEvent) => {
		// Cycle selection on left click if clicked annotation is already selected
		if (event.button == 0) {
			if (this._selectedAnnotationIDs.length) {
				let idsHere = this._iframeDocument.elementsFromPoint(event.clientX, event.clientY)
					.map(target => target.getAttribute('data-annotation-id'))
					.filter(Boolean) as string[];
				if (!idsHere.length) {
					return;
				}
				let selectedID = this._selectedAnnotationIDs.find(id => idsHere.includes(id));
				let nextID = idsHere[(selectedID ? idsHere.indexOf(selectedID) + 1 : 0) % idsHere.length];
				this._options.onSelectAnnotations([nextID], event.nativeEvent);
				if (this._selectedAnnotationIDs.length == 1) {
					this._openAnnotationPopup(this._annotationsByID.get(nextID)!);
				}
			}
			else {
				this._options.onSelectAnnotations([id], event.nativeEvent);
				if (this._selectedAnnotationIDs.length == 1) {
					this._openAnnotationPopup(this._annotationsByID.get(id)!);
				}
			}
		}
		else if (event.button == 2) {
			let br = this._iframe.getBoundingClientRect();
			if (this._selectedAnnotationIDs.includes(id)) {
				this._options.onOpenAnnotationContextMenu({
					ids: this._selectedAnnotationIDs,
					x: br.x + event.clientX,
					y: br.y + event.clientY,
					view: true,
				});
			}
			else {
				this._options.onSelectAnnotations([id], event.nativeEvent);
				this._options.onOpenAnnotationContextMenu({
					ids: [id],
					x: br.x + event.clientX,
					y: br.y + event.clientY,
					view: true,
				});
			}
		}
	};

	private _handleAnnotationDragStart = (id: string, dataTransfer: DataTransfer) => {
		let annotation = this._annotationsByID.get(id)!;
		this._options.onSetDataTransferAnnotations(dataTransfer, annotation);
		if (annotation.type === 'note') {
			this._draggingNoteAnnotation = annotation;
		}
		this._previewAnnotation = null;
		this._renderAnnotations();
	};

	private _handleAnnotationResizeStart = (_id: string) => {
		this._resizing = true;
		this._options.onSetAnnotationPopup(null);
	};

	private _handleAnnotationResizeEnd = (id: string, range: Range, cancelled: boolean) => {
		this._resizing = false;
		if (cancelled) {
			return;
		}
		let annotation = this._annotationsByID.get(id)!;
		let updatedAnnotation = this._getAnnotationFromRange(range, annotation.type);
		if (!updatedAnnotation) {
			throw new Error('Invalid resized range');
		}
		annotation.position = updatedAnnotation.position;
		annotation.pageLabel = updatedAnnotation.pageLabel;
		annotation.sortIndex = updatedAnnotation.sortIndex;
		annotation.text = updatedAnnotation.text;
		this._options.onUpdateAnnotations([annotation]);
	};

	protected _handleCopy(event: ClipboardEvent) {
		if (!event.clipboardData) {
			return;
		}
		if (this._selectedAnnotationIDs.length) {
			// It's enough to provide only one of selected annotations,
			// others will be included automatically by _onSetDataTransferAnnotations
			let annotation = this._annotationsByID.get(this._selectedAnnotationIDs[0]);
			if (!annotation) {
				return;
			}
			console.log('Copying annotation', annotation);
			this._options.onSetDataTransferAnnotations(event.clipboardData, annotation);
		}
		else {
			let annotation = this._getAnnotationFromTextSelection('highlight');
			if (!annotation) {
				return;
			}
			console.log('Copying text', annotation);
			this._options.onSetDataTransferAnnotations(event.clipboardData, annotation, true);
		}
		event.preventDefault();
	}

	protected _handlePointerDown(event: PointerEvent) {
		this._gotPointerUp = false;

		this._options.onSetOverlayPopup();

		// Create note annotation on pointer down event, if note tool is active.
		// The note tool will be automatically deactivated in reader.js,
		// because this is what we do in PDF reader
		if (event.button == 0 && this._tool.type == 'note' && this._previewAnnotation) {
			this._options.onAddAnnotation(this._previewAnnotation, true);
			event.preventDefault();

			// preventDefault() doesn't stop pointerup/click from firing, so our link handler will still fire
			// if the note is added to a link. "Fix" this by eating all click events in the next half second.
			// Very silly.
			let clickListener = (event: Event) => {
				event.stopImmediatePropagation();
				event.preventDefault();
			};
			event.target!.addEventListener('click', clickListener, { once: true, capture: true });
			setTimeout(() => {
				event.target!.removeEventListener('click', clickListener);
			}, 500);

			return;
		}

		if (!(event.target as Element).closest('.annotation-container')) {
			// Deselect annotations when clicking outside the annotation layer
			if (this._selectedAnnotationIDs.length) {
				this._options.onSelectAnnotations([], event);
			}
		}
	}

	protected _handlePointerUp(event: PointerEvent) {
		if (event.button !== 0) {
			return;
		}

		this._gotPointerUp = true;
		this._tryUseTool();
	}

	protected _handleResize() {
		this._handleViewUpdate();
	}

	protected _handleScroll() {
		this._repositionPopups();
	}

	private _handleFocus() {
		this._options.onFocus();
	}

	// ***
	// Setters that get called once there are changes in reader._state
	// ***

	setTool(tool: Tool) {
		this._tool = tool;
		let selectionColor = tool.type == 'highlight' || tool.type == 'underline' ? 'transparent' : SELECTION_COLOR;
		if (selectionColor.startsWith('#')) {
			// 50% opacity, like annotations -- not needed if we're using a system color
			selectionColor += '80';
		}
		this._iframeDocument.documentElement.style.setProperty('--selection-color', selectionColor);
		if (this._previewAnnotation && tool.type !== 'note') {
			this._previewAnnotation = null;
		}
		this._renderAnnotations();
	}

	setAnnotations(annotations: WADMAnnotation[]) {
		// Individual annotation object reference changes only if that annotation was modified,
		// so it's possible to do rendering optimizations by skipping other annotations
		this._annotations = annotations;
		this._annotationsByID = new Map(annotations.map(a => [a.id, a]));
		this._renderAnnotations();
		this._repositionPopups();
	}

	setShowAnnotations(show: boolean) {
		this._showAnnotations = show;
		this._renderAnnotations();
	}

	setSelectedAnnotationIDs(ids: string[]) {
		this._selectedAnnotationIDs = ids;
		// Close annotation popup each time when any annotation is selected, because the click is what opens the popup
		this._options.onSetAnnotationPopup();
		this._renderAnnotations();

		this._iframeWindow.getSelection()?.empty();

		this._updateViewStats();
	}

	setAnnotationPopup(popup: AnnotationPopupParams<WADMAnnotation>) {
		this._annotationPopup = popup;
	}

	setSelectionPopup(popup: SelectionPopupParams<WADMAnnotation>) {
		this._selectionPopup = popup;
	}

	setOverlayPopup(popup: OverlayPopupParams) {
		this._overlayPopup = popup;
		this._overlayPopupDelayer.setOpen(!!popup);
	}

	// ***
	// Public methods to control the view from the outside
	// ***

	focus() {
		this._iframe.focus();
	}

	navigate(location: NavLocation, options: NavigateOptions = {}) {
		if (location.annotationID) {
			options.block ||= 'center';
			options.ifNeeded ??= true;

			let annotation = this._annotationsByID.get(location.annotationID);
			if (!annotation) {
				return;
			}
			let selector = annotation.position;
			this._navigateToSelector(selector, options);
		}
		else if (location.position) {
			options.block ||= 'center';
			options.ifNeeded ??= true;

			let selector = location.position as Selector;
			this._navigateToSelector(selector, options);
			this._highlightedPosition = selector;
			this._renderAnnotations();

			setTimeout(() => {
				this._highlightedPosition = null;
				this._renderAnnotations();
			}, 2000);
		}
	}
}

export type DOMViewOptions<State extends DOMViewState> = {
	portal?: boolean;
	container: Element;
	tool: Tool;
	selectedAnnotationIDs: string[];
	annotations: WADMAnnotation[];
	showAnnotations: boolean;
	annotationPopup: AnnotationPopupParams<WADMAnnotation> | null;
	selectionPopup: SelectionPopupParams<WADMAnnotation> | null;
	overlayPopup: OverlayPopupParams | null;
	findState: FindState;
	viewState?: State;
	fontFamily?: string;
	onSetOutline: (outline: OutlineItem[]) => void;
	onChangeViewState: (state: State, primary?: boolean) => void;
	onChangeViewStats: (stats: ViewStats) => void;
	onSetDataTransferAnnotations: (dataTransfer: DataTransfer, annotation: NewAnnotation<WADMAnnotation>, fromText?: boolean) => void;
	onAddAnnotation: (annotation: NewAnnotation<WADMAnnotation>, select?: boolean) => void;
	onUpdateAnnotations: (annotations: Annotation[]) => void;
	onOpenLink: (url: string) => void;
	onSelectAnnotations: (ids: string[], triggeringEvent?: KeyboardEvent | MouseEvent) => void;
	onSetSelectionPopup: (params?: SelectionPopupParams<WADMAnnotation> | null) => void;
	onSetAnnotationPopup: (params?: AnnotationPopupParams<WADMAnnotation> | null) => void;
	onSetOverlayPopup: (params?: OverlayPopupParams) => void;
	onSetFindState: (state?: FindState) => void;
	onOpenViewContextMenu: (params: { x: number, y: number }) => void;
	onOpenAnnotationContextMenu: (params: { ids: string[], x: number, y: number, view: boolean }) => void;
	onFocus: () => void;
	onTabOut: (isShiftTab?: boolean) => void;
	onKeyUp: (event: KeyboardEvent) => void;
	onKeyDown: (event: KeyboardEvent) => void;
	buf: Uint8Array;
};

export interface DOMViewState {
	scale?: number;
}

export interface CustomScrollIntoViewOptions extends Omit<ScrollIntoViewOptions, 'inline'> {
	block?: 'center' | 'start';
	ifNeeded?: boolean;
}

export interface NavigateOptions extends CustomScrollIntoViewOptions {
	skipNavStack?: boolean;
}

export default DOMView;
