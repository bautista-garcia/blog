/** Small accessible command menu with filtering and arrow-key navigation. */
export function createCommandPalette({ dialog, input, list, commands }) {
  let activeIndex = 0;

  const visibleCommands = () => {
    const query = input.value.trim().toLowerCase();
    return commands.filter(
      (command) => !query || `${command.section} ${command.name}`.toLowerCase().includes(query),
    );
  };

  const execute = (command) => {
    dialog.close();
    command.run();
  };

  const render = () => {
    const visible = visibleCommands();
    activeIndex = Math.max(0, Math.min(activeIndex, visible.length - 1));
    list.replaceChildren();
    let section = '';

    visible.forEach((command, index) => {
      if (command.section !== section) {
        section = command.section;
        const label = document.createElement('div');
        label.className = 'command-section';
        label.textContent = section;
        list.append(label);
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `command-item${index === activeIndex ? ' active' : ''}`;
      button.role = 'option';
      button.setAttribute('aria-selected', String(index === activeIndex));

      const icon = document.createElement('span');
      icon.className = 'command-icon';
      icon.textContent = command.icon;
      const name = document.createElement('span');
      name.className = 'command-name';
      name.textContent = command.name;
      button.append(icon, name);

      if (command.keys) {
        const keys = document.createElement('kbd');
        keys.textContent = command.keys;
        button.append(keys);
      }

      button.addEventListener('mouseenter', () => {
        activeIndex = index;
        list.querySelectorAll('.command-item').forEach((item, itemIndex) => {
          item.classList.toggle('active', itemIndex === index);
        });
      });
      button.addEventListener('click', () => execute(command));
      list.append(button);
    });

    if (!visible.length) list.innerHTML = '<p class="history-empty">No matching commands.</p>';
  };

  input.addEventListener('input', () => {
    activeIndex = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    const visible = visibleCommands();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, visible.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (event.key === 'Enter' && visible[activeIndex]) {
      event.preventDefault();
      execute(visible[activeIndex]);
    }
  });

  return {
    open() {
      input.value = '';
      activeIndex = 0;
      render();
      dialog.showModal();
      requestAnimationFrame(() => input.focus());
    },
  };
}
