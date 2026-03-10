const priloader = document.querySelector('.priloader');

function priloaderView() {
    priloader.classList.add('active-priloader');
}

function disabled(num){
    form[num].addEventListener('submit', () => {
        priloaderView();
        sendBtn[num].disabled = true;
    })
}