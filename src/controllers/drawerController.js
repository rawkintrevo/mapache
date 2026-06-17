export function createDrawerController({state, render}) {
  function toggleDrawer() {
    state.drawerCollapsed = !state.drawerCollapsed;
    render();
  }

  function toggleRightDrawer() {
    state.rightDrawerCollapsed = !state.rightDrawerCollapsed;
    render();
  }

  function toggleDrawerSection(sectionId) {
    if (state.collapsedDrawerSections.has(sectionId)) {
      state.collapsedDrawerSections.delete(sectionId);
    } else {
      state.collapsedDrawerSections.add(sectionId);
    }
    render();
  }

  return {
    toggleDrawer,
    toggleRightDrawer,
    toggleDrawerSection,
  };
}
